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
const SUMMARY_OPEN = /<summary\b[^>]*>/gi
const SUMMARY_CLOSE = /<\/summary\s*>/gi

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
  readonly turn: number
  readonly step: number
  readonly signal?: AbortSignal
  readonly continuationState: TurnContinuationState
  /** Active until the step completes, errors, or the Agent is disposed. */
  active: boolean
  readonly deferred: StreamChunk[]
  readonly toolIndexes: Set<number>
  readonly toolCallIds: Set<string>
  readonly toolResultIds: Set<string>
  /** True until the core loop has closed this step's boundary. */
  stepOpen: boolean
  sawToolCall: boolean
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
  for (const match of text.matchAll(SUMMARY_OPEN)) {
    if (match.index !== undefined) tags.push({ kind: 'open', index: match.index, end: match.index + match[0].length })
  }
  for (const match of text.matchAll(SUMMARY_CLOSE)) {
    if (match.index !== undefined) tags.push({ kind: 'close', index: match.index, end: match.index + match[0].length })
  }
  return tags.sort((left, right) => left.index - right.index)
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

  const open = [...tags].reverse().find((tag) => tag.kind === 'open')
  if (!open) return undefined
  return {
    start: open.index,
    end: text.length,
    info: 'partial',
    content: text.slice(open.end),
  }
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
 *
 * `turn` and `step` remain part of the exported helper's established call
 * shape, although provenance no longer repeats those coordinates in text.
 */
function normalizeTextBlocks(texts: readonly string[], required: boolean, _turn: number, _step: number, forcedStatus?: 'partial'): { texts: string[]; summary?: SummaryInfo } {
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
  return end?.block.type === 'text' ? end.block.text : ''
}

function replaceTextChunks(chunks: readonly StreamChunk[], normalized: ReadonlyMap<number, string>): StreamChunk[] {
  const output: StreamChunk[] = []
  const emitted = new Set<number>()
  const omitted = new Set<number>()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start' && chunk.blockType === 'text') {
      const text = normalized.get(chunk.index)
      if (text === undefined) {
        output.push(chunk)
      } else if (text === '') {
        // Do not emit an empty text block after removing the hidden summary.
        // The GUI renders that block as a residual blank line below reasoning.
        omitted.add(chunk.index)
      } else if (!emitted.has(chunk.index)) {
        output.push(chunk)
        output.push({ type: 'text-delta', index: chunk.index, text })
        emitted.add(chunk.index)
      }
      continue
    }
    if (chunk.type === 'text-delta') {
      if (normalized.has(chunk.index)) {
        if (omitted.has(chunk.index)) continue
        // A delta-only stream has no block-start to anchor the replacement. The
        // replacement is inserted exactly where its first delta occurred.
        if (!emitted.has(chunk.index)) {
          const text = normalized.get(chunk.index) ?? ''
          if (text === '') {
            omitted.add(chunk.index)
            continue
          }
          output.push({ type: 'text-delta', index: chunk.index, text })
          emitted.add(chunk.index)
        }
      } else {
        output.push(chunk)
      }
      continue
    }
    if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      const text = normalized.get(chunk.index)
      if (text === undefined) output.push(chunk)
      else if (text === '') omitted.add(chunk.index)
      else if (!omitted.has(chunk.index)) output.push({ ...chunk, block: { type: 'text', text } })
      continue
    }
    output.push(chunk)
  }
  return output
}

function hideToolStepText(chunks: readonly StreamChunk[]): StreamChunk[] {
  const normalized = new Map<number, string>()
  for (const index of textBlockIndexes(chunks)) normalized.set(index, '')
  return replaceTextChunks(chunks, normalized)
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

/**
 * Tool-step prose is execution detail, not a user-facing answer. Every text
 * block of an admitted tool step is suppressed from the assistant stream
 * below, so a model cannot leak an uncontextualized progress report by
 * omitting the protocol tag. Suppressed prose is never repurposed as a
 * summary: a step without a usable `<summary>` tag is `missing`, and the
 * relay carries the standard reminder instead of the model's own words.
 */

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

function injectNextStep(state: StepState, message: UserMessage, allowClosedStep = false): boolean {
  if (!state.active || state.relayScheduled || state.relayQueued || (!allowClosedStep && !state.stepOpen) || state.signal?.aborted) return false
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

function steerReasoningContinuation(state: StepState, message: UserMessage, allowClosedStep = false): boolean {
  if (!state.active || state.relayScheduled || state.relayQueued || (!allowClosedStep && !state.stepOpen) || state.signal?.aborted) return false
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
  if (!state.active || !message || state.relayScheduled || state.relayQueued || (!allowClosedStep && !state.stepOpen) || state.signal?.aborted || state.relayAttempts >= 2) return
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

function queueFinalRelay(state: StepState): void {
  if (!state.finalRelay || state.relayScheduled || state.relayQueued) return
  // The stream is consumed before the core assistant/message append. A
  // microtask would run before that append, so this synchronous call is the
  // publication-safe path for terminal tool steps.
  appendFinalRelay(state)
}

function continueRelay(state: StepState, allowClosedStep = false): void {
  if (!state.active || !state.finalRelay) return
  injectNextStep(state, state.finalRelay, allowClosedStep)
}

function queueToolRelay(state: StepState): void {
  if (!state.active || !state.finalRelay || state.relayScheduled || state.relayQueued || !allToolResultsSettled(state)) return
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

function resetAttempt(state: StepState): void {
  state.deferred.length = 0
  state.toolIndexes.clear()
  state.toolCallIds.clear()
  state.toolResultIds.clear()
  state.sawToolCall = false
  state.sawReasoning = false
  state.toolResultCount = 0
  state.toolConcluded = false
  state.finalized = false
  state.relayQueued = false
  state.relayScheduled = false
  state.relayAttempts = 0
  state.finalRelay = undefined
  state.continuationMessage = undefined
  state.continuationPending = false
  state.continuationBlocked = false
  state.stepOpen = true
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
    if (needsReasoningContinuation && queueReasoningContinuation(state)) return deferred
    return deferred
  }

  // Summaries are required only for tool-bearing steps. A partial status is
  // forced only when such a step ended before its summary could close.
  const normalized = normalizeTextBlocks(
    texts,
    true,
    state.turn,
    state.step,
    partial ? 'partial' : undefined,
  )
  const normalizedByIndex = new Map<number, string>()
  indexes.forEach((index, position) => normalizedByIndex.set(index, normalized.texts[position]))

  // A tool step is an execution step, not a user-facing answer. Keep all of
  // its ordinary prose out of the assistant stream: the explicit summary is
  // the only action record. A step without a usable tag is `missing`, never
  // `inferred` from withheld prose, so the next step sees the standard
  // reminder instead of the model's own (often thinking-like) words.
  for (const index of indexes) normalizedByIndex.set(index, '')
  const output = replaceTextChunks(deferred, normalizedByIndex)

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
  // ends the turn persists it as durable history.
  if (terminal) queueFinalRelay(state)
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
      if (chunk.type === 'reasoning-delta' || chunk.type === 'usage' || chunk.type === 'finish') {
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
        }
        yield chunk
        continue
      }
      // Hold text and tool-call chunks until finish so the first summary can be
      // removed from the assistant output without corrupting deltas.
      state.deferred.push(chunk)
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

const PROMPT = `Tool-step communication protocol\n\nThe action summary must be emitted as visible assistant text — never as reasoning/thinking content; a reasoning-only summary is treated as missing.\n\nWhen a step calls one or more tools, emit exactly one literal XML-style summary tag as visible text immediately before the first tool call, then the call(s):\n<summary>target, concrete evidence or current state, and the immediate operation or decision</summary>\n\nThe tag is the execution record the next step receives, so be specific and actionable: name the relevant user request, artifact, observation, change, or decision, and include the concrete file, function, command, result, or constraint the next action needs. Do not replace facts with vague status language such as “continue analysis”, “make progress”, or “check the implementation”.\n\nIn a tool-calling step, emit no ordinary assistant prose outside that tag — no progress narration, internal planning, code paths, or mechanism explanations; put execution detail in the tag instead. Any visible text outside the tag is discarded: it is not shown to the user, is not carried forward, and does not count as a summary.\n\nFor a final answer with no tool call, emit no summary tag: provide one complete user-facing answer with the necessary context and conclusions. If you can produce neither a tool call nor a complete answer, emit no partial progress message; keep reasoning until you can. Never stop after reasoning alone.`

export const inject = ['agents', 'llm', 'settings', 'systemPrompt', 'tools']

export function apply(ctx: Context): void {
  const settings = ctx.settings
  const agents = ctx.agents
  let selected = selectedRoutes(undefined)
  // The selected route is supplied by DSH's model-selection layer during prompt
  // assembly. Keep only that per-agent admission snapshot; Agent.options is the
  // fallback for callers that invoke pre-step without a preceding assembly.
  const admissionSnapshots = new WeakMap<object, { route: string; enabled: boolean }>()
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

  ctx.systemPrompt.section({
    name: 'reasoning-summary:instruction',
    order: 160,
    text: (assemblyContext) => {
      const agent = (assemblyContext as { agent?: Agent }).agent
      if (!agent || !selected.has(currentRoute(agent))) return ''
      return PROMPT
    },
  })
  // The model-selection layer snapshots its selected route in the final
  // assembly variables after its inner waterfall returns. Rewrite only this
  // plugin's section from that authoritative result, so a session whose
  // Agent.options still contains the creation-time default cannot accidentally
  // receive the instruction (or miss it after selecting a configured route).
  on('system-prompt/assemble', async (assembly: any, assemblyContext: any, next: () => Promise<any>) => {
    const result = await next()
    const agent = assemblyContext?.agent as Agent | undefined
    const route = routeFromValue(result?.variables) ?? (agent === undefined ? undefined : routeKey(agent.options.provider, agent.options.model))
    const enabled = route !== undefined && selected.has(route)
    if (agent !== undefined && route !== undefined) {
      // `agent/pre-step` consumes this once. It keeps the prompt and stream
      // policy coherent when settings change between assembly and pre-step.
      admissionSnapshots.set(agent as object, { route, enabled })
    }
    return {
      ...result,
      sections: (result?.sections ?? []).map((section: any) => section?.name === 'reasoning-summary:instruction'
        ? { ...section, text: enabled ? PROMPT : '' }
        : section),
    }
  }, { prepend: true })

  const states = new WeakMap<object, StepState>()
  const sessionStates = new WeakMap<object, StepState>()
  // Continuation attempts belong to a turn, not to one stream attempt or one
  // step. A reasoning-only response creates another step, so this state must
  // survive replacement of the StepState until the turn finally closes.
  const turnStates = new WeakMap<object, TurnContinuationState>()
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
    const previousState = states.get(payload.agent)
    const previousTurnState = turnStates.get(payload.agent)
    const preserveTurnState = previousTurnState?.turn === payload.turn

    // The current route and settings are sampled once when the step is
    // admitted. A later model/settings change affects only the next step; it
    // must not discard an already-started stream or its action summary.
    if (previousState) dropState(payload.agent, previousState, preserveTurnState)

    if (!enabled) {
      if (!preserveTurnState) turnStates.delete(payload.agent)
      return next()
    }

    const continuationState: TurnContinuationState = preserveTurnState && previousTurnState !== undefined
      ? previousTurnState
      : { turn: payload.turn, attempts: 0 }
    turnStates.set(payload.agent, continuationState)
    const state: StepState = {
      agent: payload.agent as Agent,
      turn: payload.turn,
      step: payload.step,
      signal: payload.signal,
      continuationState,
      active: true,
      deferred: [],
      toolIndexes: new Set<number>(),
      toolCallIds: new Set<string>(),
      toolResultIds: new Set<string>(),
      sawToolCall: false,
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
    states.set(payload.agent, state)
    sessionStates.set((payload.agent as Agent).session as object, state)
    let pending: Promise<PreStepDecision>
    try {
      pending = next()
    } catch (error) {
      dropState(payload.agent, state)
      throw error
    }
    return pending.then((decision) => {
      if (decision.kind === 'reject') dropState(payload.agent, state)
      return decision
    }, (error) => {
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
    const state = states.get(payload.agent)
    if (state && state.active && state.turn === payload.turn && state.step === payload.step) {
      resetAttempt(state)
      // The default request-error waterfall remains authoritative; resetting
      // here lets a retry begin with a fresh per-attempt stream buffer.
    }
    return next()
  })

  on('agent/disposed', ({ agent }: any) => {
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
    const state = states.get(agent)
    if (!state || !state.active || state.turn !== turn || state.step !== step) return
    dropState(agent, state)
  })
}

export {
  MISSING_TEXT,
  PARTIAL_TEXT,
  inspectSummary,
  normalizeSummaryContent,
  normalizeTextBlocks,
  routeKey,
}
