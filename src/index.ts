/**
 * @zhourenke/dsh-reasoning-summary
 *
 * Phase-one action-summary relay for DeepSeek Harness. The host half owns the
 * durable model selection and intercepts the canonical LLM stream. The
 * canonical summaries are durable relay history: continuing relays enter the
 * next step, while tool-turn final relays remain visible in all later model
 * contexts so a model switch preserves the full action trail.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only augmentation imports. Each of these packages merges its service and
// events into the Cordis `Context`/`Events` interfaces, so the plugin must load
// the declarations to keep `ctx.settings`, `ctx.systemPrompt`, `ctx.tools`, and
// the subscribed event names typed. `import type {}` is erased at runtime and
// therefore never pulls a private copy of a host package.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'reasoning-summary'
/**
 * Settings namespace owned by this plugin. DSH validates the plain lowercase
 * form against `/^[a-z][a-z0-9-]*$/`, which this literal satisfies, so no
 * branding helper is involved: `settingsNamespace()` was removed from
 * `@deepseek-ai/dsh-settings` after 0.1.1-rc.2 and importing it would make the
 * plugin depend on a private copy of the host package.
 */
export const SETTINGS_NAMESPACE = 'reasoning-summary'

export interface ModelSelection {
  provider: string
  model: string
}

export interface ReasoningSummaryConfig {
  /** Exact provider/model routes for which this feature is active. */
  models: ModelSelection[]
}

const ModelSelectionSchema = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

/**
 * Keep the settings namespace limited to model routes. The transform also
 * normalizes settings written by older versions by dropping removed fields.
 */
const configSchema = z.transform(
  z.object({
    models: z.array(ModelSelectionSchema).default([]),
  }),
  (value) => ({ models: value.models }),
  true,
).default({ models: [] })

// The schemastery implementation carries internal package types in its
// inferred generic; this public annotation keeps generated declarations
// portable for consumers using a different pnpm layout.
export const Config = configSchema as unknown as ReturnType<typeof z.any>

const MISSING_TEXT = 'Missing action summary: no <summary> tag was received in visible text — reasoning/thinking content is never read, and text outside the tag is discarded. Before your next tool call, emit the summary as visible assistant text in a literal <summary>...</summary> tag.'
const PARTIAL_TEXT = 'Summary incomplete: the response ended before the closing tag; only a fully closed tag counts as a summary.'
const SUMMARY_TAG = /<summary\b[^>]*>|<\/summary\s*>/gi

interface SummaryInfo {
  status: 'complete' | 'partial' | 'missing'
  content: string
}

interface TurnContinuationState {
  readonly turn: number
  attempts: number
}

const MAX_REASONING_CONTINUATIONS = 3

interface StepState {
  readonly agent: Agent
  readonly route: string
  readonly turn: number
  readonly step: number
  readonly signal?: AbortSignal
  readonly continuationState: TurnContinuationState
  readonly runtime: RuntimeSessionState
  /** Active until the step completes, errors, or the Agent is disposed. */
  active: boolean
  readonly deferred: StreamChunk[]
  readonly toolIndexes: Set<number>
  readonly toolCallIds: Set<string>
  readonly toolResultIds: Set<string>
  /** True until the core loop has closed this step's boundary. */
  stepOpen: boolean
  sawToolCall: boolean
  /** A self-spin release already flushed this step's buffered text. */
  spinReleased: boolean
  /** True when the model emitted substantive reasoning without a user-facing reply. */
  sawReasoning: boolean
  toolResultCount: number
  toolConcluded: boolean
  finalized: boolean
  /** Prevent duplicate final-relay microtasks. */
  relayQueued: boolean
  /** True after a continuing relay is injected or a final relay is persisted. */
  relayScheduled: boolean
  relayAttempts: number
  finalRelay?: UserMessage
  /** Non-empty next-step prompt used by the compatibility fallback. */
  continuationMessage?: UserMessage
  /** Set by the durable-message fallback until the stop boundary can steer. */
  continuationPending: boolean
  /** A max-token/error finish must never be converted into a continuation. */
  continuationBlocked: boolean
}

const WARMUP_WINDOW_MS = 30 * 60 * 1000

interface RuntimeWarmupStep {
  readonly route: string
  readonly turn: number
  readonly step: number
  readonly signal?: AbortSignal
  entered: boolean
  sawToolCall: boolean
  assistantCompleted: boolean
  toolCallAt?: number
  /** True when this logical step entered the spin-release path. */
  spinDetected: boolean
  toolCallIds: Set<string>
  toolResultIds: Set<string>
  anonymousToolCalls: number
  anonymousToolResults: number
  interrupted: boolean
  failed: boolean
}

interface RuntimeToolSnapshot {
  route?: string
  at?: number
  spinSuppressed: boolean
}

interface RuntimeCommittedToolStep {
  readonly step: RuntimeWarmupStep
  readonly previous: RuntimeToolSnapshot
}

/**
 * Runtime-only activation state. The plugin deliberately derives this from
 * ordinary host events and never appends a plugin-owned Session record.
 */
interface RuntimeSessionState {
  /** Route of the most recently entered model step, including unselected ones. */
  lastEnteredRoute?: string
  /** Route and time of the most recent non-interrupted tool step. */
  lastToolRoute?: string
  lastToolAt?: number
  /** Suppress the plugin prompt until a later non-spin tool step succeeds. */
  spinSuppressed?: boolean
  committed?: RuntimeCommittedToolStep
  pending?: RuntimeWarmupStep
}

function warmupExpired(lastToolAt: number | undefined, now: number): boolean {
  if (lastToolAt === undefined) return true
  const elapsed = now - lastToolAt
  return elapsed < 0 || elapsed >= WARMUP_WINDOW_MS
}

function needsWarmup(state: RuntimeSessionState, route: string, now = Date.now()): boolean {
  // A released spin keeps the prompt disabled until a later non-spin tool step
  // completes successfully. This is independent of the ordinary route/time
  // checks below and therefore also survives a route that was already warm.
  if (state.spinSuppressed === true) return true
  // A route switch always starts a new warm-up, even when the route was ready
  // earlier in this Session. A successful tool step is useful warm-up evidence
  // regardless of whether the route was selected when that step entered.
  if (state.lastEnteredRoute !== route) return true
  if (state.lastToolRoute !== route) return true
  return warmupExpired(state.lastToolAt, now)
}

function eventTime(event: any): number {
  return typeof event?.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
}

function runtimeToolResultsSettled(step: RuntimeWarmupStep): boolean {
  const expected = step.toolCallIds.size + step.anonymousToolCalls
  const settled = step.toolResultIds.size + step.anonymousToolResults
  return expected > 0 && settled >= expected
}

function recordRuntimeAssistantToolCalls(step: RuntimeWarmupStep, message: AssistantMessageLike | undefined): void {
  for (const block of message?.content ?? []) {
    if (block.type !== 'tool-call') continue
    step.sawToolCall = true
    const id = typeof (block as { id?: unknown }).id === 'string' ? String((block as { id: string }).id) : ''
    if (id) step.toolCallIds.add(id)
  }
}

function routeKey(provider: unknown, model: unknown): string {
  return `${String(provider ?? '')}\u0000${String(model ?? '')}`
}

function routeFromValue(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { provider?: unknown; model?: unknown }
  if (typeof candidate.provider !== 'string' || typeof candidate.model !== 'string' || !candidate.provider || !candidate.model) return undefined
  return routeKey(candidate.provider, candidate.model)
}

function selectedRoutes(config: ReasoningSummaryConfig | undefined): ReadonlySet<string> {
  const set = new Set<string>()
  for (const entry of config?.models ?? []) {
    if (entry && typeof entry.provider === 'string' && typeof entry.model === 'string' && entry.provider && entry.model) {
      set.add(routeKey(entry.provider, entry.model))
    }
  }
  return set
}

type SummaryTag = {
  kind: 'open' | 'close'
  index: number
  end: number
}

function summaryTags(text: string): SummaryTag[] {
  const tags: SummaryTag[] = []
  // A single pass over one alternation keeps the tags in document order, so
  // the pair scan below never needs to sort them.
  for (const match of text.matchAll(SUMMARY_TAG)) {
    if (match.index === undefined) continue
    const raw = match[0]
    tags.push({
      kind: raw.startsWith('</') ? 'close' : 'open',
      index: match.index,
      end: match.index + raw.length,
    })
  }
  return tags
}

/**
 * Read the first nearest-neighbor summary pair from one text block. A stray
 * opening tag cannot claim a later pair when another opening tag appears
 * first; the nearest complete pair is authoritative. If no pair closes, the
 * last opening tag remains eligible for the existing partial-stream behavior.
 */
function inspectSummary(text: string): {
  start: number
  end: number
  info: 'complete' | 'partial'
  content: string
} | undefined {
  const tags = summaryTags(text)
  for (let index = 0; index + 1 < tags.length; index++) {
    const open = tags[index]
    const close = tags[index + 1]
    if (open.kind !== 'open' || close.kind !== 'close') continue
    return {
      start: open.index,
      end: close.end,
      info: 'complete',
      content: text.slice(open.end, close.index),
    }
  }

  // A truncated stream leaves the last opening tag eligible for the partial
  // status. Scanning backwards finds it without copying the tag list.
  for (let index = tags.length - 1; index >= 0; index--) {
    const tag = tags[index]
    if (tag.kind !== 'open') continue
    return {
      start: tag.index,
      end: text.length,
      info: 'partial',
      content: text.slice(tag.end),
    }
  }
  return undefined
}

function normalizeSummaryContent(content: string, status: 'complete' | 'partial' | 'missing'): string {
  const trimmed = content.trim()
  if (status === 'missing') return MISSING_TEXT
  if (status === 'partial') {
    const withoutNotice = trimmed.endsWith(PARTIAL_TEXT)
      ? trimmed.slice(0, -PARTIAL_TEXT.length).trim()
      : trimmed
    return withoutNotice ? `${withoutNotice}\n\n${PARTIAL_TEXT}` : PARTIAL_TEXT
  }
  return trimmed
}

function makeInfo(status: 'complete' | 'partial' | 'missing', content: string): SummaryInfo {
  return {
    status,
    content: normalizeSummaryContent(content, status),
  }
}

function findSummary(texts: readonly string[]): { block: number; found: NonNullable<ReturnType<typeof inspectSummary>> } | undefined {
  let partial: { block: number; found: NonNullable<ReturnType<typeof inspectSummary>> } | undefined
  for (let index = 0; index < texts.length; index++) {
    const found = inspectSummary(texts[index])
    if (!found) continue
    if (found.info === 'complete') return { block: index, found }
    // A literal or truncated opening tag in an earlier text block must not
    // preempt a complete nearest-neighbor pair emitted in a later block.
    partial ??= { block: index, found }
  }
  return partial
}

/**
 * Remove the authoritative summary and only the line breaks it directly
 * owns. This keeps ordinary text layout intact while preventing a hidden
 * summary from leaving a blank line at the start/end of a text block.
 */
function removeSummaryMarkup(text: string, summary: NonNullable<ReturnType<typeof inspectSummary>>): string {
  let before = text.slice(0, summary.start)
  let after = text.slice(summary.end)
  const lineBreak = /(?:\r\n|\r|\n)/

  if (before.trim() === '') {
    return after.replace(/^(?:\r\n|\r|\n)+/, '')
  }
  if (after.trim() === '') {
    return before.replace(/(?:\r\n|\r|\n)+$/, '')
  }

  if (lineBreak.test(before.slice(-2)) && /^(?:\r\n|\r|\n)/.test(after)) {
    after = after.replace(/^(?:\r\n|\r|\n)/, '')
  }
  return before + after
}

/**
 * Normalize model-emitted summary markup in pure text-block form. The
 * authoritative input tag is removed from the returned block and represented
 * by a compact action-summary relay; direct callers retain later literal tags.
 * Tool-step finalization applies the stronger UI policy by hiding every text
 * block; only an explicit tag may supply relay content.
 */
function normalizeTextBlocks(texts: readonly string[], required: boolean, forcedStatus?: 'partial'): { texts: string[]; summary?: SummaryInfo } {
  const found = findSummary(texts)
  // A model may emit the requested tag even on a step that does not call a
  // tool. If a tag is present, normalize it consistently; only a tag-free
  // optional step passes through unchanged.
  if (!found && !required) return { texts: [...texts] }

  const info = found
    ? makeInfo(forcedStatus ?? found.found.info, found.found.content)
    : makeInfo(forcedStatus ?? 'missing', '')
  const ordinary = texts.map((text, index) => {
    if (!found || index !== found.block) return text
    return removeSummaryMarkup(text, found.found)
  })

  return { texts: ordinary, summary: info }
}

function textBlockIndexes(chunks: readonly StreamChunk[]): number[] {
  const seen = new Set<number>()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start' && chunk.blockType === 'text') seen.add(chunk.index)
    else if (chunk.type === 'text-delta') seen.add(chunk.index)
    else if (chunk.type === 'block-end' && chunk.block.type === 'text') seen.add(chunk.index)
  }
  return [...seen]
}

function textForBlock(chunks: readonly StreamChunk[], index: number): string {
  const deltas = chunks
    .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta' && chunk.index === index)
    .map((chunk) => chunk.text)
  if (deltas.length > 0) return deltas.join('')

  // Some adapters expose an assembled text block only at block-end. Keep that
  // shape parseable too; otherwise a complete summary would be misclassified
  // as missing even though the block already contains its text.
  const end = chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> =>
    chunk.type === 'block-end' && chunk.index === index && chunk.block.type === 'text',
  )
  // The discriminant check is what narrows `block` to its text shape.
  return end?.block.type === 'text' ? end.block.text : ''
}

/**
 * Count complete nearest-neighbor summary pairs in combined text. Each close
 * tag pairs with the nearest unmatched open tag, so nested or interleaved tags
 * count only their complete pairs.
 */
function countCompleteSummaryPairs(text: string): number {
  const tags = summaryTags(text)
  let pairs = 0
  let opens = 0
  for (const tag of tags) {
    if (tag.kind === 'open') opens++
    else if (opens > 0) {
      opens--
      pairs++
    }
  }
  return pairs
}

function deferredText(deferred: readonly StreamChunk[]): string {
  return textBlockIndexes(deferred)
    .map((index) => textForBlock(deferred, index))
    .join('\n')
}

/**
 * Remove every text block from a tool step's stream. A hidden block emits no
 * chunks at all — not even its `block-start`/`block-end` frames — because an
 * empty text block still renders as a residual blank line below reasoning.
 * Non-text chunks (tool calls, reasoning, usage, finish) pass through in their
 * original order.
 */
function hideToolStepText(chunks: readonly StreamChunk[]): StreamChunk[] {
  const hidden = new Set(textBlockIndexes(chunks))
  const output: StreamChunk[] = []
  for (const chunk of chunks) {
    if (chunk.type === 'block-start' && chunk.blockType === 'text') {
      if (hidden.has(chunk.index)) continue
    } else if (chunk.type === 'text-delta') {
      if (hidden.has(chunk.index)) continue
    } else if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      if (hidden.has(chunk.index)) continue
    }
    output.push(chunk)
  }
  return output
}

function isToolChunk(chunk: StreamChunk): boolean {
  return chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call') || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')
}

function relayMessage(info: SummaryInfo): UserMessage {
  // Message provenance is carried in `source`; this compact, model-facing
  // header distinguishes a retained action record without duplicating plugin
  // identity or turn/step coordinates in every subsequent model request.
  const header = info.status === 'complete'
    ? '[Action summary]'
    : `[Action summary: ${info.status}]`
  return createUserMessage({
    content: [{ type: 'text', text: `${header}\n${info.content}` }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'relay',
    },
  })
}

function recordToolCallId(state: StepState, callId: unknown): void {
  if (callId !== undefined && callId !== null && String(callId) !== '') state.toolCallIds.add(String(callId))
}

function recordToolResult(state: StepState, callId: unknown): boolean {
  const id = callId === undefined || callId === null ? '' : String(callId)
  // The session feed also carries nested tool results. Only root call ids from
  // this assistant response may release its relay.
  if (state.toolCallIds.size > 0 && (id === '' || !state.toolCallIds.has(id))) return false
  if (id !== '' && state.toolResultIds.has(id)) return false
  if (id !== '') state.toolResultIds.add(id)
  state.toolResultCount++
  return true
}

function expectedToolResults(state: StepState): number {
  // The stream's distinct block indexes are authoritative. Call ids cover
  // adapters that emit only deltas and have no usable block index.
  return state.toolIndexes.size > 0 ? state.toolIndexes.size : state.toolCallIds.size
}

function allToolResultsSettled(state: StepState): boolean {
  const expected = expectedToolResults(state)
  return expected > 0 && state.toolResultCount >= expected
}

function hasText(texts: readonly string[]): boolean {
  return texts.some((text) => text.trim() !== '')
}

function summaryBaseContent(summary: SummaryInfo | undefined): string {
  if (!summary || summary.status === 'missing') return ''
  const content = summary.content.trim()
  return summary.status === 'partial' && content.endsWith(PARTIAL_TEXT)
    ? content.slice(0, -PARTIAL_TEXT.length).trim()
    : content
}

type AssistantBlockLike = { readonly type?: string; readonly text?: unknown }

type AssistantMessageLike = { readonly content?: readonly AssistantBlockLike[] }

function assistantHasToolCall(message: AssistantMessageLike): boolean {
  return (message.content ?? []).some((block) => block.type === 'tool-call')
}

function assistantHasVisibleText(message: AssistantMessageLike): boolean {
  // Durable assistant/message is only a defensive reasoning-only check. It
  // must use the same no-tool final-answer rule as the stream path: text is
  // visible verbatim, including any literal <summary> markup.
  return (message.content ?? []).some((block) => block.type === 'text'
    && typeof block.text === 'string'
    && block.text.trim() !== '')
}

function assistantNeedsContinuation(message: AssistantMessageLike): boolean {
  const hasReasoning = (message.content ?? []).some((block) => block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '')
  return hasReasoning && !assistantHasToolCall(message) && !assistantHasVisibleText(message)
}

const REASONING_CONTINUATION_TEXT = [
  '[Continue after reasoning-only response]',
  'The previous response reasoned without calling a tool or answering the user.',
  'Act now: either call the appropriate tool or provide the complete user-facing answer. Do not stop after reasoning alone.',
].join('\n')

/** A step is judged to spin once two complete nearest-neighbor tags appear. */
const SPIN_RELEASE_SUMMARIES = 2

const SPIN_NOTICE_TEXT = [
  '[No tool call received]',
  'DSH executes tools only when the assistant emits structured DSH tool-call blocks. Text that imitates a tool invocation is ordinary assistant text and is not executed.',
  'Use the appropriate structured DSH tool-call block(s) now, or stop writing summaries and provide the complete user-facing answer.',
].join('\n')

function makeReasoningContinuation(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: REASONING_CONTINUATION_TEXT }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: 'Continue after a reasoning-only response.',
    },
  })
}

function makeSpinNotice(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: SPIN_NOTICE_TEXT }],
    source: {
      kind: 'plugin',
      plugin: name,
      form: 'notice',
      summary: 'Two action summaries without a tool call.',
    },
  })
}

/**
 * The admission gate shared by every relay publication path: the step must
 * still be admitted, must not have published or queued a relay, must keep its
 * boundary open unless the caller allows a closed step, and must not be
 * aborted. Keeping this in one place stops the three call sites from drifting.
 */
function canPublish(state: StepState, allowClosedStep: boolean): boolean {
  return state.active
    && !state.relayScheduled
    && !state.relayQueued
    && (allowClosedStep || state.stepOpen)
    && !state.signal?.aborted
}

function injectNextStep(state: StepState, message: UserMessage, allowClosedStep = false): boolean {
  if (!canPublish(state, allowClosedStep)) return false
  state.relayQueued = true
  try {
    // `inject()` writes durable model-facing context. The following pre-step
    // claims it once and the agent loop appends the message exactly once.
    state.agent.inject(message)
    state.relayScheduled = true
    return true
  } catch (error) {
    state.agent.ctx.logger?.warn(`reasoning-summary: failed to queue next-step message: ${String(error)}`)
    return false
  } finally {
    state.relayQueued = false
  }
}

/**
 * A step judged to be spinning emits several complete action summaries without
 * a single tool call. Release its buffered text at once so the user can see
 * the spin and interrupt, and mark the step finalized so finish cannot run the
 * relay or continuation paths again. The queued notice is the plugin's own
 * instruction — relaying any of the model's unexecuted summaries would only
 * mislead the next step into treating plans as facts.
 */
function releaseSpinStep(state: StepState): void {
  if (state.spinReleased) return
  state.spinReleased = true
  state.runtime.spinSuppressed = true
  const pending = state.runtime.pending
  if (pending?.turn === state.turn && pending.step === state.step) pending.spinDetected = true
  state.finalized = true
  injectNextStep(state, makeSpinNotice())
}

function steerReasoningContinuation(state: StepState, message: UserMessage, allowClosedStep = false): boolean {
  if (!canPublish(state, allowClosedStep)) return false
  state.relayQueued = true
  try {
    // The native stop-boundary hook re-reads nextStep after this call. Steering
    // therefore resumes the same turn without creating a new user turn.
    state.agent.steer(message)
    state.relayScheduled = true
    return true
  } catch (error) {
    state.agent.ctx.logger?.warn(`reasoning-summary: failed to steer after reasoning-only output: ${String(error)}`)
    return false
  } finally {
    state.relayQueued = false
  }
}

function queueReasoningContinuation(state: StepState, allowClosedStep = false): boolean {
  if (!state.active || state.continuationBlocked || state.continuationState.attempts >= MAX_REASONING_CONTINUATIONS) return false
  // Keep this distinct from the normal relay path: a summary-only response
  // needs an explicit instruction to continue, not merely another summary.
  const message = state.continuationMessage ?? (state.continuationMessage = makeReasoningContinuation())
  if (!steerReasoningContinuation(state, message, allowClosedStep)) return false
  state.continuationState.attempts++
  return true
}

function deferReasoningContinuation(state: StepState): void {
  if (!state.active || state.continuationPending || state.continuationBlocked || state.relayScheduled || state.signal?.aborted) return
  if (state.continuationState.attempts >= MAX_REASONING_CONTINUATIONS) return
  state.continuationPending = true
  // `session/event` fires during Session.append's publication boundary. The
  // inbox mutation itself appends an event, so defer it until the assistant
  // event has fully returned; this still runs before the agent loop resumes
  // after its `await step()` and checks `inbox.nextStep`.
  queueMicrotask(() => {
    // If the core has already closed the step, leave the marker for the
    // `agent/turn-stopping` boundary, which is outside Session.append and can
    // safely mutate the inbox before the loop's final empty-inbox check.
    if (!state.stepOpen) return
    if (state.signal?.aborted || state.relayScheduled) {
      state.continuationPending = false
      return
    }
    state.continuationPending = false
    queueReasoningContinuation(state)
  })
}

/**
 * Append a final relay as durable, model-visible history. Unlike a one-step
 * control message, an action summary is part of the session's enduring trail:
 * every later route receives it through the normal Session projection.
 */
function appendFinalRelay(state: StepState, allowClosedStep = false): void {
  const message = state.finalRelay
  if (!message || state.relayAttempts >= 2 || !canPublish(state, allowClosedStep)) return
  state.relayQueued = true
  state.relayAttempts++
  try {
    // `Session.append` is a typed public method: `user/message` takes the
    // message itself and an append surface intent.
    state.agent.session.append('user/message', message, { surfaceOp: 'append' })
    state.relayScheduled = true
  } catch (error) {
    state.agent.ctx.logger?.warn(`reasoning-summary: failed to persist final relay: ${String(error)}`)
  } finally {
    state.relayQueued = false
  }
}

function continueRelay(state: StepState, allowClosedStep = false): void {
  if (!state.active || !state.finalRelay) return
  injectNextStep(state, state.finalRelay, allowClosedStep)
}

function queueToolRelay(state: StepState): void {
  // A closed step boundary is acceptable here: the relay is published from the
  // post-commit microtask below, which may run after `step/end`.
  if (!state.finalRelay || !canPublish(state, true) || !allToolResultsSettled(state)) return
  state.relayQueued = true
  // `tools/result` is observed before the core appends tool/result. Its
  // post-commit session/event callback schedules this microtask, so the
  // durable result is present before we inject or persist the relay. The core
  // may publish `step/end` first in an adapter-specific boundary race; an
  // already-admitted state may still publish its own relay or next-step inbox
  // entry after that boundary, before the turn is retired.
  queueMicrotask(() => {
    state.relayQueued = false
    if (!state.active || state.signal?.aborted || state.relayScheduled) return
    if (state.toolConcluded) appendFinalRelay(state, true)
    else continueRelay(state, true)
  })
}

/**
 * Mutable per-attempt fields in their start state. Step admission and retry
 * resets share this one list so a newly added field cannot be initialized in
 * one path and forgotten in the other. `active`, the buffers, and the
 * immutable identity fields are handled by their respective owners.
 */
function attemptDefaults(): Pick<StepState,
  | 'sawToolCall' | 'spinReleased' | 'sawReasoning' | 'toolResultCount' | 'toolConcluded'
  | 'finalized' | 'relayQueued' | 'relayScheduled' | 'relayAttempts'
  | 'continuationPending' | 'continuationBlocked' | 'stepOpen'> {
  return {
    sawToolCall: false,
    spinReleased: false,
    sawReasoning: false,
    toolResultCount: 0,
    toolConcluded: false,
    finalized: false,
    relayQueued: false,
    relayScheduled: false,
    relayAttempts: 0,
    continuationPending: false,
    continuationBlocked: false,
    stepOpen: true,
  }
}

function resetAttempt(state: StepState): void {
  state.deferred.length = 0
  state.toolIndexes.clear()
  state.toolCallIds.clear()
  state.toolResultIds.clear()
  Object.assign(state, attemptDefaults())
  state.finalRelay = undefined
  state.continuationMessage = undefined
}

function finishState(state: StepState, partial: boolean, terminal: boolean): StreamChunk[] {
  if (state.finalized) return []
  state.finalized = true
  const deferred = state.deferred
  const indexes = textBlockIndexes(deferred)
  const texts = indexes.map((index) => textForBlock(deferred, index))

  // A response with no tool call is a final answer candidate. Preserve every
  // deferred chunk exactly as received: no summary parser, tag removal, relay,
  // or normalization may reinterpret innocent literal markup in user-facing
  // output. Raw text is sufficient to distinguish a genuinely empty
  // reasoning-only response for the defensive continuation fallback.
  if (!state.sawToolCall) {
    const needsReasoningContinuation = !terminal
      && state.sawReasoning
      && !hasText(texts)
    if (needsReasoningContinuation) queueReasoningContinuation(state)
    return deferred
  }

  // Summaries are required only for tool-bearing steps. A partial status is
  // forced only when such a step ended before its summary could close. Only the
  // parsed summary is kept: the normalized text form is not needed because the
  // UI policy below hides every text block of a tool step.
  const normalized = normalizeTextBlocks(texts, true, partial ? 'partial' : undefined)

  // A tool step is an execution step, not a user-facing answer. Hiding every
  // text block keeps an admitted step from leaking an uncontextualized
  // progress report when the model omits the protocol tag: the explicit
  // summary is the only action record. A step without a usable tag is
  // `missing`, so the next step receives the standard reminder instead of the
  // model's own (often thinking-like) prose.
  const output = hideToolStepText(deferred)

  const extracted = normalized.summary
  const extractedContent = summaryBaseContent(extracted)
  let summary: SummaryInfo
  if (extracted && extracted.status !== 'missing' && extractedContent) {
    // A usable tag wins: complete pairs use their content; a forced/partial
    // stream keeps the received content with the incomplete notice.
    summary = makeInfo(extracted.status, extractedContent)
  } else {
    // No usable tag. A step that ended mid-stream stays `partial` so the
    // incomplete notice explains why; anything else is `missing` regardless
    // of how much visible prose the model wrote outside the tag.
    const status = partial || extracted?.status === 'partial' ? 'partial' : 'missing'
    summary = makeInfo(status, '')
  }
  state.finalRelay = relayMessage(summary)

  // Only an enabled tool-bearing step can create a relay. A continuing tool
  // loop sends it to the next step after durable tool results; a tool step that
  // ends the turn persists it as durable history. The stream is consumed
  // before the core appends the durable assistant/message, so the terminal
  // relay is persisted synchronously rather than from a microtask.
  if (terminal) appendFinalRelay(state)
  return output
}

async function* transformStream(
  state: StepState,
  source: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  // A retry may short-circuit another agent/request-error listener before this
  // plugin's listener runs. Re-arm the same step when a fresh stream enters.
  if (state.finalized) resetAttempt(state)
  try {
    for await (const chunk of source) {
      // A settings or model switch applies at the next step boundary. An
      // already-admitted enabled step owns this provider stream and must finish
      // its summary so the complete action trail remains durable.
      if (!state.active) {
        for (const deferred of state.deferred) yield deferred
        state.deferred.length = 0
        yield chunk
        for await (const remaining of source) yield remaining
        return
      }
      if (chunk.type === 'reasoning-delta' && chunk.text.trim() !== '') state.sawReasoning = true
      if (chunk.type === 'block-end' && chunk.block.type === 'reasoning' && chunk.block.text.trim() !== '') state.sawReasoning = true
      if (isToolChunk(chunk)) {
        state.sawToolCall = true
        if ('index' in chunk) state.toolIndexes.add(chunk.index)
        if (chunk.type === 'tool-call-delta') recordToolCallId(state, chunk.id)
        else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') recordToolCallId(state, chunk.block.id)
      }
      if (chunk.type === 'finish') {
        // Provider errors and aborts are handled by the agent loop's retry or
        // interruption path. Do not manufacture a relay for a failed attempt.
        if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') {
          state.continuationBlocked = chunk.reason.kind === 'max-tokens'
          for (const deferred of finishState(state, false, chunk.reason.kind === 'max-tokens')) yield deferred
        } else {
          state.continuationBlocked = true
          state.finalized = true
          // A failed attempt must not create a relay, but an already-emitted
          // tool call must not make its buffered ordinary prose visible.
          // Keep non-text chunks and the provider finish reason intact.
          const output = state.sawToolCall
            ? hideToolStepText(state.deferred)
            : state.deferred
          for (const deferred of output) yield deferred
          state.deferred.length = 0
        }
        yield chunk
        continue
      }
      // A released step passes every remaining chunk through: its text has
      // already been flushed and there is nothing left to summarize or hide.
      if (state.spinReleased) {
        yield chunk
        continue
      }
      // Hold every non-finish chunk, including reasoning and usage frames, until
      // finish. This preserves the provider's original block order for downstream
      // stream transforms such as reasoning-merge.
      state.deferred.push(chunk)
      // A self-spinning step emits two complete action summaries without a
      // single tool call. Release the buffered text at once so the user can
      // see the spin and interrupt, and queue the plugin's own notice instead
      // of relaying any of the model's unexecuted summaries.
      if (!state.sawToolCall
        && countCompleteSummaryPairs(deferredText(state.deferred)) >= SPIN_RELEASE_SUMMARIES) {
        releaseSpinStep(state)
        for (const held of state.deferred) yield held
        state.deferred.length = 0
      }
    }
    if (!state.active) {
      for (const deferred of state.deferred) yield deferred
      state.deferred.length = 0
      return
    }
    for (const deferred of finishState(state, false, false)) yield deferred
  } catch (error) {
    state.continuationBlocked = true
    if (!state.active) {
      for (const deferred of state.deferred) yield deferred
      state.deferred.length = 0
    } else {
      // A thrown provider-stream failure is equivalent to an error finish: do
      // not manufacture a partial relay, and do not reveal buffered prose from
      // an attempted tool step while the agent loop decides whether to retry.
      state.finalized = true
      const output = state.sawToolCall
        ? hideToolStepText(state.deferred)
        : state.deferred
      for (const deferred of output) yield deferred
      state.deferred.length = 0
    }
    throw error
  }
}

const PROMPT_CONTEXT_NAME = 'reasoning-summary:instruction'
const PROMPT_CONTEXT_ORDER = 130

const PROMPT = `Tool-step communication protocol

The action summary must be emitted as visible assistant text — never as reasoning/thinking content; a reasoning-only summary is treated as missing.

When a step calls one or more tools, emit exactly one literal XML-style summary tag as visible text immediately before the first tool call, then emit the tool call(s) as structured DSH tool-call block(s):
<summary>target, concrete evidence or current state, and the immediate operation or decision</summary>

DSH executes tools only from structured DSH tool-call blocks. Text that imitates a tool invocation is ordinary assistant text and is not executed. Do not write tool-call syntax as visible text.

The tag is the execution record the next step receives, so be specific and actionable: name the relevant user request, artifact, observation, change, or decision, and include the concrete file, function, command, result, or constraint the next action needs. Do not replace facts with vague status language such as “continue analysis”, “make progress”, or “check the implementation”.

In a tool-calling step, emit no ordinary assistant prose outside that tag — no progress narration, internal planning, code paths, or mechanism explanations; put execution detail in the tag instead. Any visible text outside the tag is discarded: it is not shown to the user, is not carried forward, and does not count as a summary.

For a final answer with no tool call, emit no summary tag: provide one complete user-facing answer with the necessary context and conclusions. If you can produce neither a tool call nor a complete answer, emit no partial progress message; keep reasoning until you can. Never stop after reasoning alone.`

// Only the services this half actually reads. Subscribing to `llm/stream` or
// `tools/result` does not require those packages' services in `inject` — the
// official `dsh-repeat-tool-reminder` declares no host inject at all while
// listening on the same stream — so `llm` and `tools` are deliberately absent.
// The runtime test harness provides exactly these three services, so a
// reintroduced `ctx.llm`/`ctx.tools` read fails there instead of silently
// widening the declaration.
export const inject = ['agents', 'settings', 'systemPrompt']

export function apply(ctx: Context): void {
  const settings = ctx.settings
  const agents = ctx.agents
  // Empty until the settings service answers; a registration failure disables
  // the feature outright, so no fallback value is ever read.
  let selected: ReadonlySet<string> = new Set<string>()
  // The selected route is supplied by DSH's model-selection layer during prompt
  // assembly. Keep only that per-agent admission snapshot; Agent.options is the
  // fallback for callers that invoke pre-step without a preceding assembly.
  const admissionSnapshots = new WeakMap<object, { route: string; enabled: boolean; warmup: boolean }>()
  const runtimeStates = new WeakMap<object, RuntimeSessionState>()
  const runtimeStateFor = (agent: Agent): RuntimeSessionState => {
    const session = agent.session as object
    let state = runtimeStates.get(session)
    if (!state) {
      state = {}
      runtimeStates.set(session, state)
    }
    return state
  }
  const currentRoute = (agent: Agent): string => routeKey(agent.options.provider, agent.options.model)
  const on = ctx.on.bind(ctx)

  try {
    const scope = settings.register(SETTINGS_NAMESPACE, Config)
    selected = selectedRoutes(scope.get() as ReasoningSummaryConfig)
    scope.watch((next) => {
      // Settings affect admission of the next step only. An already-admitted
      // enabled step keeps its stream and durable summary intact.
      selected = selectedRoutes(next as ReasoningSummaryConfig)
    })
  } catch (error) {
    ctx.logger?.warn(`reasoning-summary: settings registration failed; feature disabled: ${String(error)}`)
    return
  }

  ctx.systemPrompt.context({
    name: PROMPT_CONTEXT_NAME,
    // This registration is intentionally empty. Route and warm-up gating is
    // resolved by the assembly waterfall below; putting PROMPT here would make
    // it visible to every route before that decision exists.
    // The Agent Loop turns the resolved context into a durable runtime snapshot
    // only when the complete snapshot text changes.
    order: PROMPT_CONTEXT_ORDER,
    text: '',
  })
  // The model-selection layer snapshots its selected route in the final
  // assembly variables after its inner waterfall returns. Rewrite only this
  // plugin's context from that authoritative result, so a session whose
  // Agent.options still contains the creation-time default cannot accidentally
  // receive the instruction (or miss it after selecting a configured route).
  // The incoming assembly payload is unused: the authoritative result is the
  // `next()` return value, which already carries the model-selection layer's
  // final variables.
  on('system-prompt/assemble', async (_assembly: any, assemblyContext: any, next: () => Promise<any>) => {
    const result = await next()
    const agent = assemblyContext?.agent as Agent | undefined
    const route = routeFromValue(result?.variables) ?? (agent === undefined ? undefined : routeKey(agent.options.provider, agent.options.model))
    const enabled = route !== undefined && selected.has(route)
    const runtime = agent?.session === undefined ? undefined : runtimeStateFor(agent)
    const warmup = enabled && runtime !== undefined ? needsWarmup(runtime, route) : false
    const text = enabled && !warmup ? PROMPT : ''
    if (agent !== undefined && route !== undefined) {
      // `agent/pre-step` consumes this once. It keeps the context and stream
      // policy coherent when settings change between assembly and pre-step.
      admissionSnapshots.set(agent as object, { route, enabled, warmup })
    }
    return {
      ...result,
      contexts: (result?.contexts ?? []).map((context: any) => context?.name === PROMPT_CONTEXT_NAME
        ? { ...context, text }
        : context),
    }
  }, { prepend: true })

  const states = new WeakMap<object, StepState>()
  const sessionStates = new WeakMap<object, StepState>()
  // Continuation attempts belong to a turn, not to one stream attempt or one
  // step. A reasoning-only response creates another step, so this state must
  // survive replacement of the StepState until the turn finally closes.
  const turnStates = new WeakMap<object, TurnContinuationState>()
  const dropRuntimePending = (agent: Agent, turn: number, step: number): void => {
    const runtime = runtimeStateFor(agent)
    if (runtime.pending?.turn === turn && runtime.pending.step === step) runtime.pending = undefined
  }
  const markRuntimePendingFailed = (agent: Agent, turn: number, step: number): void => {
    const runtime = runtimeStateFor(agent)
    const pending = runtime.pending
    if (pending?.turn === turn && pending.step === step) pending.failed = true
    const committed = runtime.committed
    if (committed?.step.turn !== turn || committed.step.step !== step) return
    runtime.lastToolRoute = committed.previous.route
    runtime.lastToolAt = committed.previous.at
    runtime.spinSuppressed = committed.previous.spinSuppressed
    runtime.committed = undefined
  }
  const resetRuntimePendingAttempt = (agent: Agent, turn: number, step: number): void => {
    const runtime = runtimeStateFor(agent)
    const pending = runtime.pending
    if (!pending || pending.turn !== turn || pending.step !== step) return
    pending.sawToolCall = false
    pending.assistantCompleted = false
    pending.toolCallAt = undefined
    pending.toolCallIds.clear()
    pending.toolResultIds.clear()
    pending.anonymousToolCalls = 0
    pending.anonymousToolResults = 0
    pending.interrupted = false
    pending.failed = false
  }
  const dropState = (agent: object, state?: StepState, preserveTurnState = false): void => {
    const current = states.get(agent)
    const target = state ?? current
    if (!target) {
      if (!preserveTurnState) turnStates.delete(agent)
      return
    }
    target.active = false
    target.stepOpen = false
    target.continuationBlocked = true
    // A late callback may retire an older state after a new state has already
    // replaced it. Only remove shared entries that still point to that state.
    if (sessionStates.get(target.agent.session as object) === target) sessionStates.delete(target.agent.session as object)
    if (current === target) states.delete(agent)
    if (!preserveTurnState && turnStates.get(agent) === target.continuationState) turnStates.delete(agent)
  }
  on('agent/pre-step', (payload: any, next: () => Promise<PreStepDecision>) => {
    const agent = payload.agent as Agent
    const admission = admissionSnapshots.get(payload.agent)
    admissionSnapshots.delete(payload.agent)
    const route = admission?.route ?? currentRoute(agent)
    const enabled = admission?.enabled ?? selected.has(route)
    const runtime = runtimeStateFor(agent)
    const warmup = admission?.warmup ?? (enabled && needsWarmup(runtime, route))
    const previousState = states.get(payload.agent)
    const previousTurnState = turnStates.get(payload.agent)
    const preserveTurnState = previousTurnState?.turn === payload.turn

    // The current route and settings are sampled once when the step is
    // admitted. A later model/settings change affects only the next step; it
    // must not discard an already-started stream or its action summary.
    if (previousState) dropState(payload.agent, previousState, preserveTurnState)

    runtime.pending = {
      route,
      turn: payload.turn,
      step: payload.step,
      signal: payload.signal,
      spinDetected: false,
      entered: false,
      sawToolCall: false,
      assistantCompleted: false,
      toolCallIds: new Set<string>(),
      toolResultIds: new Set<string>(),
      anonymousToolCalls: 0,
      anonymousToolResults: 0,
      interrupted: false,
      failed: false,
    }

    if (!enabled || warmup) {
      if (!preserveTurnState) turnStates.delete(payload.agent)
      let pending: Promise<PreStepDecision>
      try {
        pending = next()
      } catch (error) {
        dropRuntimePending(agent, payload.turn, payload.step)
        throw error
      }
      return pending.then((decision) => {
        if (decision.kind === 'reject') dropRuntimePending(agent, payload.turn, payload.step)
        return decision
      }, (error) => {
        dropRuntimePending(agent, payload.turn, payload.step)
        throw error
      })
    }

    const continuationState: TurnContinuationState = preserveTurnState && previousTurnState !== undefined
      ? previousTurnState
      : { turn: payload.turn, attempts: 0 }
    turnStates.set(payload.agent, continuationState)
    const state: StepState = {
      agent: payload.agent as Agent,
      route,
      turn: payload.turn,
      step: payload.step,
      signal: payload.signal,
      continuationState,
      runtime,
      active: true,
      deferred: [],
      toolIndexes: new Set<number>(),
      toolCallIds: new Set<string>(),
      toolResultIds: new Set<string>(),
      ...attemptDefaults(),
    }
    states.set(payload.agent, state)
    sessionStates.set((payload.agent as Agent).session as object, state)
    let pending: Promise<PreStepDecision>
    try {
      pending = next()
    } catch (error) {
      dropRuntimePending(agent, payload.turn, payload.step)
      dropState(payload.agent, state)
      throw error
    }
    return pending.then((decision) => {
      if (decision.kind === 'reject') {
        dropRuntimePending(agent, payload.turn, payload.step)
        dropState(payload.agent, state)
      }
      return decision
    }, (error) => {
      dropRuntimePending(agent, payload.turn, payload.step)
      dropState(payload.agent, state)
      throw error
    })
  }, { prepend: true })

  on('llm/stream', (options: any, next: () => AsyncIterable<StreamChunk>) => {
    // Auxiliary calls, such as session-title generation, intentionally reuse
    // the owning session id. `purpose` is the cross-package contract for those
    // calls; `isAgentLoopRequest()` cannot be used here because its marker set is
    // module-local, and a profile plugin may hold a separate physical copy of
    // dsh-llm even when both copies share a version.
    if (options?.purpose !== undefined) return next()
    const agent = options.sessionId === undefined ? undefined : agents.get(options.sessionId)
    const state = agent === undefined ? undefined : states.get(agent)
    // The step state was admitted from one prompt/request snapshot. The core
    // Agent Loop passes this exact signal into its request. Only that exact
    // signal can identify this step; a different or missing signal is another
    // same-session call. Synthetic callers may omit both signals in tests.
    if (!state || !state.active || options.signal !== state.signal) return next()
    return transformStream(state, next() as AsyncIterable<StreamChunk>)
  })

  on('tools/result', (exec: any, result: any) => {
    const agent = exec.agent
    if (!agent || exec.parent !== undefined) return
    const state = states.get(agent)
    if (!state || !state.active || !state.finalRelay || !state.sawToolCall) return
    // This notification is pre-commit: the core appends the durable
    // `tool/result` immediately after the tools waterfall returns. Only carry
    // the conclusion bit here; the post-commit session/event hook owns result
    // counting and relay scheduling.
    state.toolConcluded ||= result.concludesTurn === true
  })

  // `tools/result` is emitted before the agent loop appends the durable
  // `tool/result`. Observe that committed event as well: this covers callers
  // that publish a result without going through ToolRuntime.
  on('session/event', (session: any, event: any) => {
    const runtime = runtimeStates.get(session)
    const pending = runtime?.pending
    const matchesPending = pending !== undefined
      && event.data?.turn === pending.turn
      && event.data?.step === pending.step

    if (matchesPending && runtime !== undefined) {
      if (event.type === 'step/start') {
        runtime.committed = undefined
        pending.entered = true
        runtime.lastEnteredRoute = pending.route
      } else if (event.type === 'assistant/message') {
        if (event.data.interrupted === true) {
          pending.interrupted = true
        } else {
          pending.assistantCompleted = true
          const hadToolCall = pending.sawToolCall
          recordRuntimeAssistantToolCalls(pending, event.data.message)
          if (!hadToolCall && pending.sawToolCall) pending.toolCallAt = eventTime(event)
        }
      } else if (event.type === 'tool/call') {
        pending.sawToolCall = true
        pending.toolCallAt ??= eventTime(event)
        const callId = event.data.callId === undefined || event.data.callId === null ? '' : String(event.data.callId)
        if (callId) pending.toolCallIds.add(callId)
        else pending.anonymousToolCalls++
      } else if (event.type === 'tool/result') {
        const callId = event.data.message?.source?.callId
        const id = callId === undefined || callId === null ? '' : String(callId)
        if (id) {
          if (pending.toolCallIds.has(id) && !pending.toolResultIds.has(id)) pending.toolResultIds.add(id)
        } else {
          pending.anonymousToolResults++
        }
      } else if (event.type === 'step/end') {
        if (pending.entered
          && pending.sawToolCall
          && pending.assistantCompleted
          && !pending.interrupted
          && !pending.failed
          && !pending.signal?.aborted
          && runtimeToolResultsSettled(pending)) {
          const previous: RuntimeToolSnapshot = {
            route: runtime.lastToolRoute,
            at: runtime.lastToolAt,
            spinSuppressed: runtime.spinSuppressed === true,
          }
          runtime.lastToolRoute = pending.route
          runtime.lastToolAt = pending.toolCallAt ?? eventTime(event)
          if (!pending.spinDetected) runtime.spinSuppressed = false
          runtime.committed = { step: pending, previous }
        }
        runtime.pending = undefined
      }
    }

    const state = sessionStates.get(session)
    if (!state || !state.active) return
    if (event.data?.turn !== state.turn || event.data?.step !== state.step) return
    // Live sessions in the supported host publish no `assistant/chunk` event:
    // chunk frames travel through `agent/assistant-stream` and the durable
    // settlement is `assistant/message` / `assistant/attempt`. The finish-reason
    // guard lives on the `llm/stream` path (see `transformStream`), which is the
    // only live source for max-tokens/error/aborted settlement.
    if (event.type === 'assistant/message') {
      if (event.data.interrupted === true) state.continuationBlocked = true
      // The installed DSH PreparedLlmCall.stream() enters the same llm/stream
      // waterfall. Inspecting the durable assistant message remains a defensive
      // fallback for callers that publish the event without this stream hook.
      if (assistantNeedsContinuation(event.data.message)) {
        state.sawReasoning = true
        deferReasoningContinuation(state)
      }
      return
    }
    if (event.type === 'step/end') {
      state.stepOpen = false
      return
    }
    if (event.type !== 'tool/result') return
    const callId = event.data.message?.source?.callId
    if (!recordToolResult(state, callId)) return
    queueToolRelay(state)
  })

  on('agent/request-error', (payload: any, next: () => Promise<RequestErrorAction>) => {
    resetRuntimePendingAttempt(payload.agent, payload.turn, payload.step)
    const state = states.get(payload.agent)
    if (state && state.active && state.turn === payload.turn && state.step === payload.step) {
      resetAttempt(state)
      // The default request-error waterfall remains authoritative; resetting
      // here lets a retry begin with a fresh per-attempt stream buffer.
    }
    return next()
  })

  on('agent/disposed', ({ agent }: any) => {
    const runtime = runtimeStates.get((agent as Agent).session as object)
    if (runtime?.pending !== undefined) runtime.pending.failed = true
    dropState(agent)
  })
  on('agent/turn-stopping', ({ agent, turn }: any) => {
    const state = states.get(agent)
    if (!state || !state.active || state.turn !== turn) return
    // A committed concluding tool result can be followed immediately by
    // `step/end`. If that boundary wins the relay microtask race, persist the
    // already-admitted step's durable summary here instead of losing it.
    if (state.finalRelay && state.sawToolCall && state.toolConcluded && allToolResultsSettled(state)) {
      appendFinalRelay(state, true)
    }
    // A durable assistant/message fallback normally queues its notice in the
    // microtask immediately after Session.append returns. If the core reaches
    // this boundary first, the step is already closed, but the inbox is still
    // safe to mutate here. Keep the turn state alive because the new step must
    // share the same bounded continuation counter.
    if (state.continuationPending) {
      state.continuationPending = false
      if (queueReasoningContinuation(state, true)) return
    }
    dropState(agent, state)
  })
  on('agent/error', ({ agent, turn, step }: any) => {
    markRuntimePendingFailed(agent, turn, step)
    const state = states.get(agent)
    if (!state || !state.active || state.turn !== turn || state.step !== step) return
    dropState(agent, state)
  })
}

export {
  MISSING_TEXT,
  PARTIAL_TEXT,
  inspectSummary,
  normalizeTextBlocks,
  routeKey,
}
