import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply as applyRepeatToolReminder } from '@deepseek-ai/dsh-repeat-tool-reminder'
import { apply, MISSING_TEXT, PARTIAL_TEXT, routeKey } from '../lib/index.js'

function streamOf(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

function deferred() {
  let resolve
  const promise = new Promise((resume) => { resolve = resume })
  return { promise, resolve }
}

async function collectStream(iterable) {
  const output = []
  for await (const chunk of iterable) output.push(chunk)
  return output
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve))
}

function makeHarness(config) {
  const listeners = new Map()
  const contexts = []
  const appended = []
  const injected = []
  const steered = []
  const agentById = new Map()
  let currentConfig = config
  let settingsWatcher
  let syntheticWarmupId = 0
  const scope = {
    get: () => currentConfig,
    watch: (listener) => {
      settingsWatcher = listener
      return () => { if (settingsWatcher === listener) settingsWatcher = undefined }
    },
  }
  const ctx = {
    settings: { register: () => scope },
    agents: { get: (id) => agentById.get(id) },
    systemPrompt: { context: (context) => { contexts.push(context); return () => {} } },
    logger: { warn: () => {} },
    on: (name, listener) => { listeners.set(name, listener); return () => {} },
  }
  apply(ctx)

  function createTestSession(id) {
    const raw = Session.create(id)
    let publishing = false
    const session = {
      id: raw.id,
      // The supported host exposes the durable log through `snapshotEvents()`;
      // this convenience accessor keeps the assertions readable.
      get events() { return raw.snapshotEvents() },
      get header() { return raw.header },
      get surface() { return raw.surface },
      deriveMessages: () => raw.deriveMessages(),
      append(type, data, options) {
        if (publishing) throw new Error('session append cannot reenter while another append is being published')
        publishing = true
        try {
          const event = raw.append(type, data, options)
          appended.push(event)
          listeners.get('session/event')?.(session, event)
          return event
        } finally {
          publishing = false
        }
      },
      raw,
    }
    return session
  }

  function emitSessionEvent(session, event) {
    listeners.get('session/event')?.(session, event)
  }

  function routeIsSelected(route) {
    return (currentConfig.models ?? []).some((entry) => routeKey(entry.provider, entry.model) === routeKey(route.provider, route.model))
  }

  function primeRoute(agent, route) {
    const previous = { provider: agent.options.provider, model: agent.options.model }
    agent.options.provider = route.provider
    agent.options.model = route.model
    const turn = 100000 + (++syntheticWarmupId)
    const step = 1
    const callId = `synthetic-warmup-${syntheticWarmupId}`
    const preStep = listeners.get('agent/pre-step')
    const admitted = preStep({ agent, turn, step }, async () => ({ kind: 'enter', messages: [] }))
    Promise.resolve(admitted).catch(() => {})
    const now = Date.now()
    emitSessionEvent(agent.session, { type: 'step/start', time: now, data: { turn, step } })
    emitSessionEvent(agent.session, {
      type: 'assistant/message',
      time: now,
      data: {
        turn,
        step,
        message: { content: [{ type: 'tool-call', id: callId }] },
      },
    })
    emitSessionEvent(agent.session, {
      type: 'tool/call',
      time: now,
      data: { turn, step, callId },
    })
    emitSessionEvent(agent.session, {
      type: 'tool/result',
      time: now,
      data: { turn, step, message: { source: { callId } } },
    })
    emitSessionEvent(agent.session, { type: 'step/end', time: now, data: { turn, step } })
    agent.options.provider = previous.provider
    agent.options.model = previous.model
  }

  const autoPrime = config.autoPrime !== false
  return {
    listeners,
    contexts,
    appended,
    injected,
    steered,
    agentById,
    createTestSession,
    emitSessionEvent,
    primeRoute,
    autoPrime,
    routeIsSelected,
    updateSettings(next) {
      currentConfig = next
      settingsWatcher?.(next)
    },
  }
}

function makeAgent(harness, id = 'session-1') {
  const inbox = []
  const session = harness.createTestSession(id)
  const agent = {
    id,
    options: { provider: 'cotton-codex', model: 'gpt-5.6-luna' },
    inject(message) {
      this.session.append('agent/inbox/spliced', {
        target: 'next-step',
        start: inbox.length,
        inserted: [message],
      })
      inbox.push(message)
      harness.injected.push(message)
    },
    steer(message) {
      this.session.append('agent/inbox/spliced', {
        target: 'next-step',
        start: inbox.length,
        inserted: [message],
      })
      inbox.push(message)
      harness.steered.push(message)
    },
    inbox: {
      remove(messageId) {
        const index = inbox.findIndex((message) => message.id === messageId)
        if (index < 0) return false
        inbox.splice(index, 1)
        return true
      },
    },
    takeInbox() {
      return inbox.splice(0)
    },
    session,
    ctx: { logger: { warn: () => {} } },
  }
  harness.agentById.set(id, agent)
  if (harness.autoPrime && harness.routeIsSelected(agent.options)) harness.primeRoute(agent, agent.options)
  return agent
}

function mainStreamOptions(agent, signal) {
  return {
    sessionId: agent.id,
    ...(signal === undefined ? {} : { signal }),
  }
}

function textStart(index = 0) {
  return { type: 'block-start', index, blockType: 'text' }
}

function textDelta(text, index = 0) {
  return { type: 'text-delta', index, text }
}

function textEnd(text, index = 0) {
  return { type: 'block-end', index, block: { type: 'text', text } }
}

function finish(kind = 'stop') {
  return { type: 'finish', reason: { kind } }
}

function textFrom(chunks) {
  return chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
}

function mergeReasoningBlocks(chunks) {
  const blocks = []
  let current
  for (const chunk of chunks) {
    if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') {
      assert.equal(current, undefined, 'reasoning blocks must close before the next block starts')
      current = ''
    } else if (chunk.type === 'reasoning-delta') {
      assert.notEqual(current, undefined, 'reasoning delta must follow its block-start')
      current += chunk.text
    } else if (chunk.type === 'block-end' && chunk.block.type === 'reasoning') {
      assert.notEqual(current, undefined, 'reasoning block-end must follow its block-start')
      blocks.push(current)
      current = undefined
    }
  }
  assert.equal(current, undefined, 'reasoning blocks must be complete')
  return blocks
}

function appendAssistant(agent, turn, step, content) {
  // `assistant/message` embeds its own provider stream: the event carries the
  // (empty, for these synthetic commits) `stream` array and must NOT cite
  // `sourceEventSeqs`, which the surface contract reserves for the other
  // message-producing event types.
  return agent.session.append('assistant/message', {
    turn,
    step,
    message: createAssistantMessage({
      content,
      source: { provider: agent.options.provider, model: agent.options.model },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
}

function appendToolResult(agent, turn, step, callId, text = 'tool output') {
  const call = agent.session.append('tool/call', {
    turn,
    step,
    callId,
    name: 'read_file',
    arguments: '{}',
  })
  return agent.session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, {
    surfaceOp: 'append',
    sourceEventSeqs: [call.seq],
  })
}

function relayEvents(session) {
  return session.events.filter((event) => event.type === 'user/message' && event.data.source?.form === 'relay')
}

function relayMessages(session) {
  return session.deriveMessages().filter((message) => message.source?.form === 'relay')
}

function appendUserMessage(agent, text, source = {}) {
  return agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source,
  }), { surfaceOp: 'append' })
}

async function assembleWithRoute(harness, agent, provider, model) {
  const assemble = harness.listeners.get('system-prompt/assemble')
  return assemble({}, { agent }, async () => ({
    sections: [
      { name: 'other-plugin:section', text: 'keep this section' },
    ],
    contexts: [
      { name: 'reasoning-summary:instruction', text: 'placeholder' },
    ],
    tools: [],
    variables: { provider, model },
  }))
}

async function admitRoute(harness, agent, { provider, model, turn, step, messages = [], signal }) {
  const assembly = await assembleWithRoute(harness, agent, provider, model)
  const preStep = harness.listeners.get('agent/pre-step')
  const decision = await preStep({
    agent,
    turn,
    step,
    messages,
    ...(signal === undefined ? {} : { signal }),
  }, async () => ({ kind: 'enter', messages }))
  if (decision.kind === 'enter') {
    harness.emitSessionEvent(agent.session, {
      type: 'step/start',
      time: Date.now(),
      data: { turn, step },
    })
  }
  return { assembly, decision }
}

function emitRuntimeToolLifecycle(harness, agent, { turn, step, callId, time = Date.now(), interrupted = false, error = false }) {
  harness.emitSessionEvent(agent.session, {
    type: 'assistant/message',
    time,
    data: {
      turn,
      step,
      ...(interrupted ? { interrupted: true } : {}),
      message: { content: [{ type: 'tool-call', id: callId }] },
    },
  })
  harness.emitSessionEvent(agent.session, {
    type: 'tool/call',
    time,
    data: { turn, step, callId },
  })
  harness.emitSessionEvent(agent.session, {
    type: 'tool/result',
    time,
    data: { turn, step, message: { source: { callId } } },
  })
  harness.emitSessionEvent(agent.session, { type: 'step/end', time, data: { turn, step } })
  if (error) harness.listeners.get('agent/error')?.({ agent, turn, step })
}

async function completeConcludedToolStep(harness, agent, { turn, step, summary, callId }) {
  const stream = harness.listeners.get('llm/stream')
  const toolResult = harness.listeners.get('tools/result')
  const chunks = [
    textStart(),
    textDelta(`<summary>${summary}</summary>`, 0),
    textEnd(`<summary>${summary}</summary>`, 0),
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: callId, name: 'read_file', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' } },
    finish(),
  ]
  const output = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(chunks))) output.push(chunk)
  appendAssistant(agent, turn, step, [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' }])
  toolResult({ agent, callId, parent: undefined }, { concludesTurn: true })
  appendToolResult(agent, turn, step, callId)
  harness.emitSessionEvent(agent.session, {
    type: 'step/end',
    time: Date.now(),
    data: { turn, step },
  })
  await flushMicrotasks()
  return { chunks, output }
}

async function completeTransparentStep(harness, agent, { turn, step, chunks }) {
  const stream = harness.listeners.get('llm/stream')
  const output = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(chunks))) output.push(chunk)
  const text = textFrom(chunks)
  harness.emitSessionEvent(agent.session, {
    type: 'assistant/message',
    time: Date.now(),
    data: { turn, step, message: { content: [{ type: 'text', text }] } },
  })
  harness.emitSessionEvent(agent.session, {
    type: 'step/end',
    time: Date.now(),
    data: { turn, step },
  })
  await flushMicrotasks()
  return { chunks, output }
}

test('a cold selected route warms transparently after its first real tool step', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const harness = makeHarness({ models: [route], autoPrime: false })
  const agent = makeAgent(harness)

  const warmup = await admitRoute(harness, agent, { ...route, turn: 1, step: 1 })
  assert.equal(warmup.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  const warmupChunks = [textStart(), textDelta('transparent warm-up'), textEnd('transparent warm-up'), finish()]
  const warmupOutput = await collectStream(harness.listeners.get('llm/stream')(mainStreamOptions(agent), () => streamOf(warmupChunks)))
  assert.deepEqual(warmupOutput, warmupChunks)
  await completeConcludedToolStep(harness, agent, {
    turn: 1, step: 1, summary: 'the first real tool action completed', callId: 'cold-1',
  })
  assert.equal(relayMessages(agent.session).length, 0)
  assert.equal(agent.session.events.some((event) => event.type === 'reasoning-summary/warmup'), false)

  const active = await admitRoute(harness, agent, { ...route, turn: 1, step: 2 })
  assert.match(active.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, /Tool-step communication protocol/)
  await completeConcludedToolStep(harness, agent, {
    turn: 1, step: 2, summary: 'the next tool action was processed', callId: 'cold-2',
  })
  assert.equal(relayMessages(agent.session).length, 1)
})

test('a final answer without a tool keeps the selected route cold', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const harness = makeHarness({ models: [route], autoPrime: false })
  const agent = makeAgent(harness)
  const first = await admitRoute(harness, agent, { ...route, turn: 1, step: 1 })
  assert.equal(first.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  const finalChunks = [textStart(), textDelta('a direct answer'), textEnd('a direct answer'), finish()]
  assert.deepEqual(
    await collectStream(harness.listeners.get('llm/stream')(mainStreamOptions(agent), () => streamOf(finalChunks))),
    finalChunks,
  )
  harness.emitSessionEvent(agent.session, { type: 'step/end', time: Date.now(), data: { turn: 1, step: 1 } })

  const second = await admitRoute(harness, agent, { ...route, turn: 2, step: 1 })
  assert.equal(second.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  await completeConcludedToolStep(harness, agent, {
    turn: 2, step: 1, summary: 'the first tool step of the second turn warmed the route', callId: 'direct-then-tool',
  })
  const afterWarmup = await admitRoute(harness, agent, { ...route, turn: 2, step: 2 })
  assert.match(afterWarmup.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, /Tool-step communication protocol/)
})

test('a route switch rewarms even a route that was ready earlier', async () => {
  const A = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const B = { provider: 'bailian', model: 'deepseek-v4-flash' }
  const harness = makeHarness({ models: [A, B] })
  const agent = makeAgent(harness)

  await admitRoute(harness, agent, { ...A, turn: 1, step: 1 })
  await completeConcludedToolStep(harness, agent, { turn: 1, step: 1, summary: 'A used a ready route', callId: 'switch-ready-a' })

  agent.options.provider = B.provider
  agent.options.model = B.model
  const bWarmup = await admitRoute(harness, agent, { ...B, turn: 2, step: 1 })
  assert.equal(bWarmup.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  await completeConcludedToolStep(harness, agent, { turn: 2, step: 1, summary: 'B completed its warm-up action', callId: 'switch-warm-b' })

  agent.options.provider = A.provider
  agent.options.model = A.model
  const aWarmup = await admitRoute(harness, agent, { ...A, turn: 3, step: 1 })
  assert.equal(aWarmup.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  await completeConcludedToolStep(harness, agent, { turn: 3, step: 1, summary: 'A completed its new warm-up action', callId: 'switch-warm-a' })
  const activeA = await admitRoute(harness, agent, { ...A, turn: 3, step: 2 })
  assert.match(activeA.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, /Tool-step communication protocol/)
})

test('warm-up reuse expires at 30 minutes from the last tool step', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const harness = makeHarness({ models: [route], autoPrime: false })
    const agent = makeAgent(harness)
    await admitRoute(harness, agent, { ...route, turn: 1, step: 1 })
    await completeConcludedToolStep(harness, agent, { turn: 1, step: 1, summary: 'the reference tool step completed', callId: 'time-1' })

    now += 30 * 60 * 1000 - 1
    const withinWindow = await admitRoute(harness, agent, { ...route, turn: 2, step: 1 })
    assert.match(withinWindow.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, /Tool-step communication protocol/)

    now += 1
    const atBoundary = await admitRoute(harness, agent, { ...route, turn: 3, step: 1 })
    assert.equal(atBoundary.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  } finally {
    Date.now = originalNow
  }
})

test('a recent non-tool step does not refresh the last tool timestamp', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const originalNow = Date.now
  const base = 2_000_000
  Date.now = () => base
  try {
    const harness = makeHarness({ models: [route], autoPrime: false })
    const agent = makeAgent(harness)
    await admitRoute(harness, agent, { ...route, turn: 1, step: 1 })
    emitRuntimeToolLifecycle(harness, agent, { turn: 1, step: 1, callId: 'timer-tool', time: base })

    Date.now = () => base + 10 * 60 * 1000
    const nonTool = await admitRoute(harness, agent, { ...route, turn: 2, step: 1 })
    assert.match(nonTool.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, /Tool-step communication protocol/)
    harness.emitSessionEvent(agent.session, {
      type: 'assistant/message',
      time: base + 10 * 60 * 1000,
      data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'direct answer' }] } },
    })
    harness.emitSessionEvent(agent.session, {
      type: 'step/end',
      time: base + 10 * 60 * 1000,
      data: { turn: 2, step: 1 },
    })

    Date.now = () => base + 30 * 60 * 1000
    const expired = await admitRoute(harness, agent, { ...route, turn: 3, step: 1 })
    assert.equal(expired.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  } finally {
    Date.now = originalNow
  }
})

test('a failed tool step does not mark the route ready', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const harness = makeHarness({ models: [route], autoPrime: false })
  const agent = makeAgent(harness)
  await admitRoute(harness, agent, { ...route, turn: 1, step: 1 })
  emitRuntimeToolLifecycle(harness, agent, { turn: 1, step: 1, callId: 'failed-tool', error: true })
  assert.equal(agent.session.events.some((event) => event.type === 'reasoning-summary/warmup'), false)
  const retry = await admitRoute(harness, agent, { ...route, turn: 2, step: 1 })
  assert.equal(retry.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
})

test('an interrupted tool step does not mark the route ready', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const harness = makeHarness({ models: [route], autoPrime: false })
  const agent = makeAgent(harness)
  const controller = new AbortController()
  await admitRoute(harness, agent, { ...route, turn: 1, step: 1, signal: controller.signal })
  controller.abort()
  emitRuntimeToolLifecycle(harness, agent, { turn: 1, step: 1, callId: 'aborted-tool', interrupted: true })
  const retry = await admitRoute(harness, agent, { ...route, turn: 2, step: 1 })
  assert.equal(retry.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
})

test('runtime warm-up state is isolated per Session', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const harness = makeHarness({ models: [route], autoPrime: false })
  const first = makeAgent(harness, 'warmup-first')
  const second = makeAgent(harness, 'warmup-second')
  await admitRoute(harness, first, { ...route, turn: 1, step: 1 })
  emitRuntimeToolLifecycle(harness, first, { turn: 1, step: 1, callId: 'first-tool' })
  const firstReady = await admitRoute(harness, first, { ...route, turn: 1, step: 2 })
  const secondCold = await admitRoute(harness, second, { ...route, turn: 1, step: 1 })
  assert.match(firstReady.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, /Tool-step communication protocol/)
  assert.equal(secondCold.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
})
test('the runtime context is present only for the selected exact route', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  assert.equal(harness.contexts.length, 1)
  const context = harness.contexts[0]
  assert.equal(context.name, 'reasoning-summary:instruction')
  assert.equal(context.order, 130)
  assert.equal(context.text, '')
  const selected = { options: { provider: 'cotton-codex', model: 'gpt-5.6-luna' } }
  const other = { options: { provider: 'cotton', model: 'gpt-5.6-luna' } }
  const selectedAssembly = await assembleWithRoute(harness, selected, 'cotton-codex', 'gpt-5.6-luna')
  const otherAssembly = await assembleWithRoute(harness, other, 'cotton', 'gpt-5.6-luna')
  const selectedText = selectedAssembly.contexts.find((entry) => entry.name === 'reasoning-summary:instruction').text
  const otherText = otherAssembly.contexts.find((entry) => entry.name === 'reasoning-summary:instruction').text
  assert.match(selectedText, /Tool-step communication protocol/)
  assert.match(selectedText, /exactly one literal XML-style summary tag as visible text immediately before the first tool call/)
  assert.match(selectedText, /reasoning-only summary is treated as missing/)
  assert.match(selectedText, /emit no ordinary assistant prose outside that tag/)
  assert.match(selectedText, /Any visible text outside the tag is discarded/)
  assert.match(selectedText, /specific and actionable/)
  assert.equal(otherText, '')
})

test('route changes update only the runtime-context contribution', async () => {
  const selectedRoute = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const otherRoute = { provider: 'bailian', model: 'deepseek-v4-flash' }
  const harness = makeHarness({ models: [selectedRoute] })
  const agent = makeAgent(harness)

  const selected = await assembleWithRoute(harness, agent, selectedRoute.provider, selectedRoute.model)
  assert.match(selected.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, /Tool-step communication protocol/)
  assert.deepEqual(selected.sections, [
    { name: 'other-plugin:section', text: 'keep this section' },
  ])

  const disabled = await assembleWithRoute(harness, agent, otherRoute.provider, otherRoute.model)
  assert.equal(disabled.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  assert.deepEqual(disabled.sections, selected.sections)

  const selectedAgain = await assembleWithRoute(harness, agent, selectedRoute.provider, selectedRoute.model)
  const selectedAgainText = selectedAgain.contexts.find((context) => context.name === 'reasoning-summary:instruction').text
  assert.match(selectedAgainText, /Tool-step communication protocol/)
  assert.equal(selectedAgainText, selected.contexts.find((context) => context.name === 'reasoning-summary:instruction').text)
  // The registered slot itself stays empty; only each assembled context copy is
  // rewritten, which is what lets RuntimeContextProjection compare snapshots.
  assert.equal(harness.contexts[0].text, '')
})

test('final assembled variables choose new-summary behavior without hiding existing history', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const stale = appendUserMessage(agent, 'A action summary stays available to every route', {
    kind: 'plugin', plugin: 'reasoning-summary', form: 'relay',
    provider: 'cotton-codex', model: 'gpt-5.6-luna',
  })
  const external = appendUserMessage(agent, 'context from another plugin', {
    kind: 'plugin', plugin: 'dsh-openwolf', form: 'context',
  })
  const preStep = harness.listeners.get('agent/pre-step')

  const disabledAssembly = await assembleWithRoute(harness, agent, 'bailian', 'deepseek-v4-flash')
  assert.equal(disabledAssembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  const disabledDecision = await preStep({ agent, turn: 20, step: 1 }, async () => ({
    kind: 'enter', messages: [stale.data, external.data],
  }))
  assert.deepEqual(disabledDecision.messages.map((message) => message.id), [stale.data.id, external.data.id])
  assert.equal(agent.session.deriveMessages().some((message) => message.id === stale.data.id), true)
  assert.equal(agent.session.events.some((event) => event.surfaceOp?.op === 'replace'), false)

  const enabledAssembly = await assembleWithRoute(harness, agent, 'cotton-codex', 'gpt-5.6-luna')
  assert.match(enabledAssembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, /Tool-step communication protocol/)
})

test('disabled routes pass through without prompt or stream changes', async () => {
  const harness = makeHarness({ models: [] })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  const chunks = [textStart(), textDelta('ordinary'), textEnd('ordinary'), finish()]
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const result = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(chunks))) result.push(chunk)
  assert.deepEqual(result, chunks)
  assert.equal(harness.contexts[0].text, '')
  assert.equal(harness.injected.length, 0)
  assert.equal(harness.appended.length, 0)
})

test('an unselected route keeps every existing summary but does not process new summaries', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  agent.options.provider = 'bailian'
  agent.options.model = 'deepseek-v4-flash'
  const staleRoute = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const legacyRelay = appendUserMessage(agent, '[Reasoning summary history]\nlegacy summary', {
    kind: 'plugin', plugin: 'reasoning-summary', form: 'relay',
  })
  const taggedRelay = appendUserMessage(agent, '[Reasoning summary history]\nA summary', {
    kind: 'plugin', plugin: 'reasoning-summary', form: 'relay', ...staleRoute,
  })
  const continuation = appendUserMessage(agent, '[Reasoning summary continuation]\ncontinue prior work', {
    kind: 'plugin', plugin: 'reasoning-summary', form: 'notice',
    summary: 'Continue after a reasoning-only response.', ...staleRoute,
  })
  const external = appendUserMessage(agent, 'context from another plugin', {
    kind: 'plugin', plugin: 'dsh-openwolf', form: 'context',
  })
  const preStep = harness.listeners.get('agent/pre-step')
  await preStep({ agent, turn: 9, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))

  const snapshot = agent.session.deriveMessages()
  assert.equal(snapshot.some((message) => message.id === legacyRelay.data.id), true)
  assert.equal(snapshot.some((message) => message.id === taggedRelay.data.id), true)
  assert.equal(snapshot.some((message) => message.id === continuation.data.id), true)
  assert.equal(snapshot.some((message) => message.id === external.data.id), true)
  assert.equal(harness.contexts[0].text, '')
  assert.equal(agent.session.events.some((event) => event.surfaceOp?.op === 'replace'), false)
})

test('an unselected route never creates a relay or continuation', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  agent.options.provider = 'bailian'
  agent.options.model = 'deepseek-v4-flash'
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 12, step: 1 }, async () => ({ kind: 'enter', messages: [] }))

  const reasoning = [
    { type: 'reasoning-delta', index: 0, text: 'I should inspect the workspace.' },
    finish(),
  ]
  const reasoningResult = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(reasoning))) reasoningResult.push(chunk)
  assert.deepEqual(reasoningResult, reasoning)

  const callId = 'call-unselected-route'
  const toolChunks = [
    textStart(),
    textDelta('<summary>prepared an unavailable-route tool action</summary>', 0),
    textEnd('<summary>prepared an unavailable-route tool action</summary>', 0),
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: callId, name: 'read_file', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' } },
    finish(),
  ]
  const toolResult = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(toolChunks))) toolResult.push(chunk)
  assert.deepEqual(toolResult, toolChunks)

  appendAssistant(agent, 12, 1, [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' }])
  appendToolResult(agent, 12, 1, callId)
  await flushMicrotasks()
  assert.equal(harness.injected.length, 0)
  assert.equal(harness.steered.length, 0)
  assert.equal(relayEvents(agent.session).length, 0)
})

test('every route sees the complete existing relay history', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const legacyRelay = appendUserMessage(agent, 'legacy relay remains durable history', {
    kind: 'plugin', plugin: 'reasoning-summary', form: 'relay',
  })
  const otherRouteRelay = appendUserMessage(agent, 'relay created by another route remains visible', {
    kind: 'plugin', plugin: 'reasoning-summary', form: 'relay',
    provider: 'bailian', model: 'deepseek-v4-flash',
  })
  const other = appendUserMessage(agent, 'other plugin context remains', {
    kind: 'plugin', plugin: 'dsh-openwolf', form: 'context',
  })
  const preStep = harness.listeners.get('agent/pre-step')
  await preStep({ agent, turn: 10, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  const selectedSnapshot = agent.session.deriveMessages()
  assert.equal(selectedSnapshot.some((message) => message.id === legacyRelay.data.id), true)
  assert.equal(selectedSnapshot.some((message) => message.id === otherRouteRelay.data.id), true)
  assert.equal(selectedSnapshot.some((message) => message.id === other.data.id), true)

  agent.options.provider = 'bailian'
  agent.options.model = 'deepseek-v4-flash'
  await preStep({ agent, turn: 10, step: 2, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  const unselectedSnapshot = agent.session.deriveMessages()
  assert.equal(unselectedSnapshot.some((message) => message.id === legacyRelay.data.id), true)
  assert.equal(unselectedSnapshot.some((message) => message.id === otherRouteRelay.data.id), true)
  assert.equal(unselectedSnapshot.some((message) => message.id === other.data.id), true)
  assert.equal(agent.session.events.some((event) => event.surfaceOp?.op === 'replace'), false)
})

test('an admitted enabled step keeps stream normalization after settings change', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const stream = harness.listeners.get('llm/stream')
  await admitRoute(harness, agent, {
    provider: 'cotton-codex', model: 'gpt-5.6-luna', turn: 11, step: 1,
  })
  const source = (async function* () {
    yield textStart()
    yield textDelta('buffered before settings change')
    harness.updateSettings({ models: [] })
    yield textDelta(' and the admitted step still finishes')
    yield textEnd('buffered before settings change and the admitted step still finishes')
    yield finish()
  })()
  const result = []
  for await (const chunk of stream(mainStreamOptions(agent), () => source)) result.push(chunk)
  assert.equal(textFrom(result), 'buffered before settings change and the admitted step still finishes')
  assert.equal(result.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text'), true)
  assert.equal(harness.steered.length, 0)
  assert.equal(harness.injected.length, 0)
})

test('an admitted A tool step persists its summary after switching to disabled B mid-stream', async () => {
  const A = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const B = { provider: 'bailian', model: 'deepseek-v4-flash' }
  const harness = makeHarness({ models: [A] })
  const agent = makeAgent(harness)
  const stream = harness.listeners.get('llm/stream')
  await admitRoute(harness, agent, { ...A, turn: 30, step: 1 })

  const callId = 'mid-stream-switch'
  const source = (async function* () {
    yield textStart()
    yield textDelta('<summary>A prepared the tool before the route switch</summary>')
    yield textEnd('<summary>A prepared the tool before the route switch</summary>')
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 1, id: callId, name: 'read_file', argumentsDelta: '{}' }
    harness.updateSettings({ models: [] })
    agent.options.provider = B.provider
    agent.options.model = B.model
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' } }
    yield finish()
  })()
  const output = []
  for await (const chunk of stream(mainStreamOptions(agent), () => source)) output.push(chunk)

  appendAssistant(agent, 30, 1, [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' }])
  harness.listeners.get('tools/result')({ agent, callId, parent: undefined }, { concludesTurn: true })
  appendToolResult(agent, 30, 1, callId, 'done')
  await flushMicrotasks()

  const relays = relayMessages(agent.session)
  assert.equal(relays.length, 1)
  assert.match(relays[0].content[0].text, /A prepared the tool before the route switch/)
  assert.deepEqual(relays[0].source, {
    kind: 'plugin', plugin: 'reasoning-summary', form: 'relay',
  })
  await admitRoute(harness, agent, { ...B, turn: 31, step: 1 })
  assert.equal(relayMessages(agent.session).length, 1)
})

test('A enabled then B disabled then A enabled shares history but only A creates summaries', async () => {
  const A = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const B = { provider: 'bailian', model: 'deepseek-v4-flash' }
  const harness = makeHarness({ models: [A] })
  const agent = makeAgent(harness)

  await admitRoute(harness, agent, { ...A, turn: 1, step: 1 })
  await completeConcludedToolStep(harness, agent, {
    turn: 1, step: 1, summary: 'A inspected the workspace', callId: 'a-1',
  })
  assert.equal(relayMessages(agent.session).length, 1)

  agent.options.provider = B.provider
  agent.options.model = B.model
  const beforeB = relayMessages(agent.session)
  await admitRoute(harness, agent, { ...B, turn: 2, step: 1 })
  assert.equal(relayMessages(agent.session).length, 1)
  assert.deepEqual(relayMessages(agent.session).map((message) => message.id), beforeB.map((message) => message.id))
  const disabledOutput = []
  const disabledChunks = [textStart(), textDelta('B reads A history'), textEnd('B reads A history'), finish()]
  for await (const chunk of harness.listeners.get('llm/stream')({ sessionId: agent.id }, () => streamOf(disabledChunks))) disabledOutput.push(chunk)
  assert.deepEqual(disabledOutput, disabledChunks)
  assert.equal(relayMessages(agent.session).length, 1)

  agent.options.provider = A.provider
  agent.options.model = A.model
  const beforeSecondA = relayMessages(agent.session)
  await admitRoute(harness, agent, { ...A, turn: 3, step: 1 })
  assert.deepEqual(relayMessages(agent.session).map((message) => message.id), beforeSecondA.map((message) => message.id))
  await completeConcludedToolStep(harness, agent, {
    turn: 3, step: 1, summary: 'A warmed the route after switching back', callId: 'a-warmup',
  })
  assert.equal(relayMessages(agent.session).length, 1)
  await admitRoute(harness, agent, { ...A, turn: 3, step: 2 })
  await completeConcludedToolStep(harness, agent, {
    turn: 3, step: 2, summary: 'A completed the next workspace action', callId: 'a-2',
  })
  assert.equal(relayMessages(agent.session).length, 2)
})

test('disabling and re-enabling A pauses new summaries without hiding old ones', async () => {
  const A = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const harness = makeHarness({ models: [A] })
  const agent = makeAgent(harness)

  await admitRoute(harness, agent, { ...A, turn: 1, step: 1 })
  await completeConcludedToolStep(harness, agent, {
    turn: 1, step: 1, summary: 'A recorded the first action', callId: 'toggle-1',
  })
  const firstHistory = relayMessages(agent.session)
  assert.equal(firstHistory.length, 1)

  harness.updateSettings({ models: [] })
  const disabled = await admitRoute(harness, agent, { ...A, turn: 2, step: 1 })
  assert.equal(disabled.decision.kind, 'enter')
  assert.deepEqual(relayMessages(agent.session).map((message) => message.id), firstHistory.map((message) => message.id))
  const disabledOutput = []
  const disabledChunks = [textStart(), textDelta('the disabled interval creates no summary'), textEnd('the disabled interval creates no summary'), finish()]
  for await (const chunk of harness.listeners.get('llm/stream')({ sessionId: agent.id }, () => streamOf(disabledChunks))) disabledOutput.push(chunk)
  assert.deepEqual(disabledOutput, disabledChunks)
  assert.equal(relayMessages(agent.session).length, 1)

  harness.updateSettings({ models: [A] })
  await admitRoute(harness, agent, { ...A, turn: 3, step: 1 })
  assert.equal(relayMessages(agent.session).length, 1)
  await completeConcludedToolStep(harness, agent, {
    turn: 3, step: 1, summary: 'A resumed summary generation', callId: 'toggle-2',
  })
  assert.equal(relayMessages(agent.session).length, 2)
})

test('a successful tool step on an unselected route can warm later selection', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const harness = makeHarness({ models: [] })
  const agent = makeAgent(harness)

  const disabled = await admitRoute(harness, agent, { ...route, turn: 1, step: 1 })
  assert.equal(disabled.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  const disabledTool = await completeConcludedToolStep(harness, agent, {
    turn: 1, step: 1, summary: 'the unselected route still used a tool', callId: 'unselected-tool',
  })
  assert.deepEqual(disabledTool.output, disabledTool.chunks)
  assert.equal(relayMessages(agent.session).length, 0)

  harness.updateSettings({ models: [route] })
  const reenabled = await admitRoute(harness, agent, { ...route, turn: 2, step: 1 })
  assert.match(reenabled.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, /Tool-step communication protocol/)
  await completeConcludedToolStep(harness, agent, {
    turn: 2, step: 1, summary: 'the re-enabled route reused the prior tool warm-up', callId: 'reenabled-active',
  })
  assert.equal(relayMessages(agent.session).length, 1)
})

test('A enabled B disabled C enabled D disabled exposes complete history to every route', async () => {
  const A = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const B = { provider: 'bailian', model: 'deepseek-v4-flash' }
  const C = { provider: 'cotton-codex', model: 'gpt-5.6-mini' }
  const D = { provider: 'openai', model: 'gpt-4.1-mini' }
  const harness = makeHarness({ models: [A, C] })
  const agent = makeAgent(harness)

  await admitRoute(harness, agent, { ...A, turn: 1, step: 1 })
  await completeConcludedToolStep(harness, agent, {
    turn: 1, step: 1, summary: 'A created the first history entry', callId: 'abcd-a',
  })
  const historyAfterA = relayMessages(agent.session)
  assert.equal(historyAfterA.length, 1)

  agent.options.provider = B.provider
  agent.options.model = B.model
  await admitRoute(harness, agent, { ...B, turn: 2, step: 1 })
  assert.deepEqual(relayMessages(agent.session).map((message) => message.id), historyAfterA.map((message) => message.id))

  agent.options.provider = C.provider
  agent.options.model = C.model
  await admitRoute(harness, agent, { ...C, turn: 3, step: 1 })
  assert.deepEqual(relayMessages(agent.session).map((message) => message.id), historyAfterA.map((message) => message.id))
  await completeConcludedToolStep(harness, agent, {
    turn: 3, step: 1, summary: 'C warmed the route after switching', callId: 'abcd-c-warmup',
  })
  const historyAfterCWarmup = relayMessages(agent.session)
  assert.equal(historyAfterCWarmup.length, 1)
  await admitRoute(harness, agent, { ...C, turn: 3, step: 2 })
  assert.deepEqual(relayMessages(agent.session).map((message) => message.id), historyAfterCWarmup.map((message) => message.id))
  await completeConcludedToolStep(harness, agent, {
    turn: 3, step: 2, summary: 'C added the second history entry', callId: 'abcd-c',
  })
  const historyAfterC = relayMessages(agent.session)
  assert.equal(historyAfterC.length, 2)

  agent.options.provider = D.provider
  agent.options.model = D.model
  await admitRoute(harness, agent, { ...D, turn: 4, step: 1 })
  assert.deepEqual(relayMessages(agent.session).map((message) => message.id), historyAfterC.map((message) => message.id))
  const disabledOutput = []
  const disabledChunks = [textStart(), textDelta('D reads both prior summaries'), textEnd('D reads both prior summaries'), finish()]
  for await (const chunk of harness.listeners.get('llm/stream')({ sessionId: agent.id }, () => streamOf(disabledChunks))) disabledOutput.push(chunk)
  assert.deepEqual(disabledOutput, disabledChunks)
  assert.equal(relayMessages(agent.session).length, 2)
})

test('a B-only initial session creates no summary, then switching to A starts fresh history', async () => {
  const A = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const B = { provider: 'bailian', model: 'deepseek-v4-flash' }
  const harness = makeHarness({ models: [A] })
  const agent = makeAgent(harness)
  agent.options.provider = B.provider
  agent.options.model = B.model

  await admitRoute(harness, agent, { ...B, turn: 1, step: 1 })
  const disabledOutput = []
  const disabledChunks = [textStart(), textDelta('B has no summary history yet'), textEnd('B has no summary history yet'), finish()]
  for await (const chunk of harness.listeners.get('llm/stream')({ sessionId: agent.id }, () => streamOf(disabledChunks))) disabledOutput.push(chunk)
  assert.deepEqual(disabledOutput, disabledChunks)
  assert.equal(relayMessages(agent.session).length, 0)

  agent.options.provider = A.provider
  agent.options.model = A.model
  await admitRoute(harness, agent, { ...A, turn: 2, step: 1 })
  assert.equal(relayMessages(agent.session).length, 0)
  const warmupChunks = [textStart(), textDelta('A warms after the route switch'), textEnd('A warms after the route switch'), finish()]
  const warmupOutput = []
  for await (const chunk of harness.listeners.get('llm/stream')(mainStreamOptions(agent), () => streamOf(warmupChunks))) warmupOutput.push(chunk)
  assert.deepEqual(warmupOutput, warmupChunks)
  await completeConcludedToolStep(harness, agent, {
    turn: 2, step: 1, summary: 'A completed the warm-up tool action', callId: 'switch-a-warmup',
  })
  assert.equal(relayMessages(agent.session).length, 0)
  await admitRoute(harness, agent, { ...A, turn: 2, step: 2 })
  await completeConcludedToolStep(harness, agent, {
    turn: 2, step: 2, summary: 'A created the first summary after switching', callId: 'switch-a',
  })
  assert.equal(relayMessages(agent.session).length, 1)
  assert.match(relayMessages(agent.session)[0].content[0].text, /A created the first summary after switching/)
})

test('a step admitted while enabled keeps its continuation after a later route switch', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const stream = harness.listeners.get('llm/stream')
  await admitRoute(harness, agent, {
    provider: 'cotton-codex', model: 'gpt-5.6-luna', turn: 21, step: 1,
  })
  harness.updateSettings({ models: [] })
  const reasoning = [
    { type: 'reasoning-delta', index: 0, text: 'I was preparing an action.' },
    finish(),
  ]
  const result = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(reasoning))) result.push(chunk)
  await flushMicrotasks()
  assert.deepEqual(result, reasoning)
  assert.equal(harness.steered.length, 1)
})

test('an unmarked session-title stream cannot consume an active agent-step buffer', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const stream = harness.listeners.get('llm/stream')
  const mainSignal = new AbortController().signal
  await admitRoute(harness, agent, {
    provider: 'cotton-codex', model: 'gpt-5.6-luna', turn: 1, step: 1, signal: mainSignal,
  })

  const mainPaused = deferred()
  const resumeMain = deferred()
  const mainChunks = [
    { type: 'reasoning-delta', index: 0, text: 'I have an answer.' },
    textStart(0),
    textDelta('The main answer must stay on the main stream.', 0),
    textEnd('The main answer must stay on the main stream.', 0),
    finish(),
  ]
  const mainSource = (async function* () {
    yield mainChunks[0]
    yield mainChunks[1]
    yield mainChunks[2]
    mainPaused.resolve()
    await resumeMain.promise
    yield mainChunks[3]
    yield mainChunks[4]
  })()
  const mainOutputPromise = collectStream(stream(mainStreamOptions(agent, mainSignal), () => mainSource))
  await mainPaused.promise

  const titleChunks = [
    textStart(1),
    textDelta('Concise session title', 1),
    textEnd('Concise session title', 1),
    finish(),
  ]
  const titleOutput = await collectStream(stream({
    sessionId: agent.id,
    purpose: 'session-title',
    signal: new AbortController().signal,
  }, () => streamOf(titleChunks)))
  resumeMain.resolve()
  const mainOutput = await mainOutputPromise

  assert.deepEqual(titleOutput, titleChunks)
  assert.deepEqual(mainOutput, mainChunks)
  assert.equal(harness.steered.length, 0)
})

test('an unpurposed same-session stream with a different or missing signal cannot affect an admitted step', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const stream = harness.listeners.get('llm/stream')
  const mainSignal = new AbortController().signal
  await admitRoute(harness, agent, {
    provider: 'cotton-codex', model: 'gpt-5.6-luna', turn: 1, step: 1, signal: mainSignal,
  })

  const foreignChunks = [
    { type: 'reasoning-delta', index: 0, text: 'This belongs to a different same-session call.' },
    finish(),
  ]
  const foreignOptions = [
    { sessionId: agent.id, signal: new AbortController().signal },
    { sessionId: agent.id },
  ]
  for (const options of foreignOptions) {
    const output = await collectStream(stream(options, () => streamOf(foreignChunks)))
    assert.deepEqual(output, foreignChunks)
  }
  await flushMicrotasks()

  assert.equal(harness.steered.length, 0)
})

test('a reasoning-only first step steers a bounded internal continuation', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  const reasoning = [
    { type: 'reasoning-delta', index: 0, text: 'I need to inspect the workspace first.' },
    finish(),
  ]

  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const first = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(reasoning))) first.push(chunk)

  assert.deepEqual(first, reasoning)
  assert.equal(harness.injected.length, 0)
  assert.equal(harness.steered.length, 1)
  const continuation = harness.steered[0]
  assert.equal(continuation.role, 'user')
  // 'plugin', never 'user' — a user-sourced message would clear
  // dsh-repeat-tool-reminder's repeat chain; see the note on `relay.source.kind`
  // later in this file.
  assert.equal(continuation.source.kind, 'plugin')
  assert.equal(continuation.source.form, 'notice')
  assert.ok(continuation.content[0].text.trim().length > 0)
  assert.match(continuation.content[0].text, /^\[Continue after reasoning-only response\]\n/)
  assert.match(continuation.content[0].text, /reasoned without calling a tool or answering the user/)
  assert.match(continuation.content[0].text, /Act now: either call the appropriate tool or provide the complete user-facing answer\./)
  assert.doesNotMatch(continuation.content[0].text, /Reasoning summary continuation|Normalized summary from the previous response/)

  const preStep2 = harness.listeners.get('agent/pre-step')
  const decision = await preStep2({ agent, turn: 1, step: 2 }, async () => ({
    kind: 'enter',
    messages: agent.takeInbox(),
  }))
  assert.strictEqual(decision.messages[0], continuation)

  // A provider that repeatedly emits reasoning alone must not create an
  // unbounded loop. Each new step receives at most one further continuation.
  for (let step = 2; step <= 5; step++) {
    const result = []
    for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(reasoning))) result.push(chunk)
    if (step < 4) assert.equal(harness.steered.length, step)
    else assert.equal(harness.steered.length, 3)
    if (step < 5) {
      await preStep2({ agent, turn: 1, step: step + 1 }, async () => ({
        kind: 'enter',
        messages: agent.takeInbox(),
      }))
    }
  }
  assert.equal(harness.steered.length, 3)
})

test('an admitted enabled tool step publishes its relay after settings are disabled', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  await admitRoute(harness, agent, {
    provider: 'cotton-codex', model: 'gpt-5.6-luna', turn: 22, step: 1,
  })
  harness.updateSettings({ models: [] })
  await completeConcludedToolStep(harness, agent, {
    turn: 22, step: 1, summary: 'completed the admitted tool action', callId: 'call-route-switch',
  })

  assert.equal(relayEvents(agent.session).length, 1)
  assert.deepEqual(relayEvents(agent.session)[0].data.source, {
    kind: 'plugin', plugin: 'reasoning-summary', form: 'relay',
  })
})

test('a steered continuation remains durable and visible after the next step', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 1, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  for await (const _chunk of stream(mainStreamOptions(agent), () => streamOf([
    { type: 'reasoning-delta', index: 0, text: 'I need one more action.' },
    finish(),
  ]))) {}

  const continuation = harness.steered.at(-1)
  assert.ok(continuation)
  const decision = await preStep({ agent, turn: 1, step: 2, messages: agent.takeInbox() }, async () => ({
    kind: 'enter',
    messages: [continuation],
  }))
  assert.strictEqual(decision.messages[0], continuation)
  agent.session.append('user/message', continuation, { surfaceOp: 'append' })

  // Both the current request and every later route retain the continuation;
  // no agent/request hook removes or masks this durable context.
  assert.equal(agent.session.deriveMessages().some((message) => message.id === continuation.id), true)
  agent.options.provider = 'bailian'
  agent.options.model = 'deepseek-v4-flash'
  await preStep({ agent, turn: 1, step: 3, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(agent.session.deriveMessages().some((message) => message.id === continuation.id), true)
  assert.equal(agent.session.events.some((event) => event.surfaceOp?.op === 'replace'), false)
})

test('a disabled next step keeps an existing continuation but creates no new plugin output', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 1, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  for await (const _chunk of stream(mainStreamOptions(agent), () => streamOf([
    { type: 'reasoning-delta', index: 0, text: 'I must inspect before answering.' },
    finish(),
  ]))) {}
  const continuation = harness.steered.at(-1)
  assert.ok(continuation)

  harness.updateSettings({ models: [] })
  const decision = await preStep({ agent, turn: 1, step: 2, messages: agent.takeInbox() }, async () => ({
    kind: 'enter',
    messages: [continuation],
  }))
  assert.deepEqual(decision.messages, [continuation])
  assert.equal(harness.contexts[0].text, '')

  const chunks = [textStart(), textDelta('ordinary disabled-route output'), textEnd('ordinary disabled-route output'), finish()]
  const output = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(chunks))) output.push(chunk)
  assert.deepEqual(output, chunks)
  assert.equal(harness.steered.length, 1)
  assert.equal(harness.injected.length, 0)
})

test('a durable reasoning-only assistant message steers the defensive continuation fallback', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))

  // The real agent loop appends this event after a prepared call as well.
  // The installed PreparedLlmCall path uses llm/stream; this test exercises the
  // defensive durable-event fallback and its publication-boundary timing.
  appendAssistant(agent, 1, 1, [{ type: 'reasoning', text: 'I am still planning the first action.' }])
  assert.equal(harness.steered.length, 0)
  await flushMicrotasks()

  assert.equal(harness.steered.length, 1)
  assert.ok(harness.steered[0].content[0].text.trim().length > 0)
  assert.match(harness.steered[0].content[0].text, /Do not stop after reasoning alone/)
})

test('a pending durable continuation survives the step-close boundary race', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const turnStopping = harness.listeners.get('agent/turn-stopping')
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  appendAssistant(agent, 1, 1, [{ type: 'reasoning', text: 'The close boundary raced the fallback.' }])

  // If the session event's microtask has not run yet, the turn-stopping hook
  // must still steer the next step outside the Session.append boundary.
  agent.session.append('step/end', { turn: 1, step: 1 })
  turnStopping({ agent, turn: 1 })
  await flushMicrotasks()

  assert.equal(harness.steered.length, 1)
  assert.ok(harness.steered[0].content[0].text.trim().length > 0)
})

test('error and aborted tool attempts hide buffered prose without creating a relay', async () => {
  for (const kind of ['error', 'aborted']) {
    const harness = makeHarness({
      models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
    })
    const agent = makeAgent(harness, `failed-${kind}`)
    const preStep = harness.listeners.get('agent/pre-step')
    const stream = harness.listeners.get('llm/stream')
    await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
    const result = []
    for await (const chunk of stream(mainStreamOptions(agent), () => streamOf([
      textStart(0),
      textDelta('Internal parser and test mechanics must not appear after a failed tool attempt.', 0),
      textEnd('Internal parser and test mechanics must not appear after a failed tool attempt.', 0),
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: `failed-${kind}`, name: 'read_file', argumentsDelta: '{}' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: `failed-${kind}`, name: 'read_file', arguments: '{}' } },
      finish(kind),
    ]))) result.push(chunk)

    assert.equal(textFrom(result), '')
    assert.equal(result.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'text'), false)
    assert.equal(result.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text'), false)
    assert.equal(result.some((chunk) => chunk.type === 'tool-call-delta'), true)
    assert.equal(result.at(-1).reason.kind, kind)
    assert.equal(harness.injected.length, 0)
    assert.equal(relayEvents(agent.session).length, 0)
  }
})

test('a thrown tool-stream failure hides buffered prose without creating a relay', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness, 'thrown-tool-error')
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const result = []
  const source = (async function* () {
    yield textStart(0)
    yield textDelta('Internal stream ownership diagnostics must remain hidden after failure.', 0)
    yield textEnd('Internal stream ownership diagnostics must remain hidden after failure.', 0)
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 1, id: 'thrown-tool-error', name: 'read_file', argumentsDelta: '{}' }
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'thrown-tool-error', name: 'read_file', arguments: '{}' } }
    throw new Error('provider stream failed')
  })()

  await assert.rejects(async () => {
    for await (const chunk of stream(mainStreamOptions(agent), () => source)) result.push(chunk)
  }, /provider stream failed/)

  assert.equal(textFrom(result), '')
  assert.equal(result.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'text'), false)
  assert.equal(result.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text'), false)
  assert.equal(result.some((chunk) => chunk.type === 'tool-call-delta'), true)
  assert.equal(harness.injected.length, 0)
  assert.equal(relayEvents(agent.session).length, 0)
})

test('max-token reasoning output remains terminal and does not seed another step', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const result = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf([
    { type: 'reasoning-delta', index: 0, text: 'The response reached its output limit.' },
    finish('max-tokens'),
  ]))) result.push(chunk)

  assert.equal(harness.injected.length, 0)
  assert.equal(result.at(-1).reason.kind, 'max-tokens')
})

test('a visible durable assistant answer is not mistaken for a reasoning-only response', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  appendAssistant(agent, 1, 1, [
    { type: 'reasoning', text: 'I have enough information now.' },
    { type: 'text', text: 'Here is the user-facing answer.' },
  ])
  await flushMicrotasks()

  assert.equal(harness.injected.length, 0)
  assert.equal(agent.session.deriveMessages().some((message) => message.role === 'assistant' && message.content.some((block) => block.type === 'text' && block.text === 'Here is the user-facing answer.')), true)
})

test('ordinary assistant text remains visible after summary normalization', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const result = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf([
    textStart(),
    textDelta('<summary>prepared the response</summary>\\nVisible answer remains here.', 0),
    textEnd('<summary>prepared the response</summary>\\nVisible answer remains here.', 0),
    finish(),
  ]))) result.push(chunk)
  assert.match(textFrom(result), /Visible answer remains here/)
  assert.doesNotMatch(textFrom(result), /source="reasoning-summary"/)
})

test('the client does not install a global chat-row hiding filter', () => {
  for (const file of ['../src/client.ts', '../lib/client.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /data-reasoning-summary-hidden/)
    assert.doesNotMatch(source, /MutationObserver/)
    assert.doesNotMatch(source, /hideMarkedChatRows/)
  }
})

test('the settings card reads the Host catalog through the remote session namespace', () => {
  for (const file of ['../src/client.ts', '../lib/client.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    // Host 0.1.2-rc.1 removed `connection.api`, so the legacy path must never
    // return: it answers undefined and surfaces as a permanent catalog failure.
    assert.doesNotMatch(source, /connection\.api/)
    assert.doesNotMatch(source, /api\.llm/)
    // The catalog comes from the generated `session/modelCatalog` Remote method.
    assert.match(source, /modelCatalog\(\)/)
    assert.match(source, /'remote\.session'/)
    // Activation must gate on the namespace service, not on a cached property.
    assert.match(source, /inject: \['slots', 'settingsScope', 'locale', 'remote', 'remote\.session'\]/)
  }
})

test('the settings card follows official plugin-card chrome and exposes model routes only', () => {
  for (const file of ['../src/client.ts', '../lib/client.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    // Card shell mirrors PluginCard (ui-settings-plugins): hairline border on
    // the l4 token, 16px radius, open state on bg-layer-2.
    assert.match(source, /e\('li', \{\s*className: `rs-card/)
    assert.match(source, /\.rs-card \{[^}]*border:\s*\.5px solid var\(--dsw-alias-border-l4\)/)
    assert.match(source, /\.rs-card \{[^}]*border-radius:\s*16px/)
    assert.doesNotMatch(source, /\.rs-card \{[^}]*overflow\s*:/)
    assert.doesNotMatch(source, /border-left:\s*3px/)
    assert.doesNotMatch(source, /['"]⌄['"]/)
    assert.match(source, /IconChevronDownOutline14/)
    assert.doesNotMatch(source, /rs-select(?:-chevron)?/)
    assert.doesNotMatch(source, /e\('select'/)
    assert.match(source, /\.rs-model-label \{[^}]*font-weight:\s*500;\s*line-height:\s*1\.5/)
    // Model list mirrors SubagentModelSelectionCard: bordered fieldset with
    // provider groups and a three-column row (checkbox / name+route / action).
    assert.match(source, /\.rs-models \{[^}]*border:\s*\.5px solid var\(--dsw-alias-border-l4\);[^}]*border-radius:\s*8px;[^}]*max-height:\s*280px/)
    assert.match(source, /\.rs-model \{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;[^}]*padding:\s*6px/)
    assert.match(source, /\.rs-model-group \+ \.rs-model-group \{[^}]*border-top:\s*\.5px solid var\(--dsw-alias-border-l3\)/)
    // Unavailable rows mirror the Subagent card: a plain checkbox row with the
    // unavailable label, no trash/delete control of any kind.
    assert.match(source, /\.rs-unavailable \{[^}]*color:\s*var\(--dsw-alias-label-tertiary\);[^}]*font-size:\s*11px/)
    assert.doesNotMatch(source, /IconTrashOutline16/)
    assert.doesNotMatch(source, /\.rs-icon-button/)
    assert.doesNotMatch(source, /removeModel\s*:\s*['"](?:删除模型|Remove model)['"]/)
    // All routes missing from the catalog collect in one trailing group,
    // regardless of whether their provider survived.
    assert.match(source, /unavailable\.push\(item\)/)
    assert.doesNotMatch(source, /staleByProvider/)
    assert.doesNotMatch(source, /orphanStale/)
    // No manual "refresh catalog" control remains; failures offer a retry.
    assert.doesNotMatch(source, /refresh\s*:\s*['"](?:刷新目录|Refresh catalog)['"]/)
    assert.doesNotMatch(source, /\.rs-refresh/)
    assert.doesNotMatch(source, /cleanup\s*:\s*['"](?:清理选择|Remove selection)['"]/)
    assert.match(source, /retry\s*:\s*['"](?:重试|Retry)['"]/)
    assert.match(source, /\.rs-discard:hover:not\(:disabled\) \{[^}]*color:\s*var\(--dsw-alias-label-primary\);[^}]*border-color:\s*var\(--dsw-alias-label-dimmed\)/)
    assert.doesNotMatch(source, /\.rs-discard:hover:not\(:disabled\) \{[^}]*background\s*:/)
    assert.match(source, /\.rs-save \{[^}]*background:\s*var\(--dsw-alias-label-primary\);[^}]*color:\s*var\(--dsw-alias-bg-layer-3\)/)
    assert.doesNotMatch(source, /\.rs-save:hover\s*\{/)
    assert.match(source, /\.rs-discard:disabled, \.rs-save:disabled \{[^}]*opacity:\s*\.4;[^}]*cursor:\s*default/)
    assert.match(source, /\.rs-discard:focus-visible, \.rs-save:focus-visible \{[^}]*outline:\s*2px solid var\(--dsw-alias-brand-primary\);[^}]*outline-offset:\s*1px/)
    assert.match(source, /模型目录中不可用且已启用的条目仍会保留显示。/)
    assert.match(source, /Enabled entries that are unavailable in the model catalog remain visible\./)
  }
})

test('reasoning block frames stay ordered for downstream merging', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness, 'reasoning-order')
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))

  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'inspect ' },
    { type: 'reasoning-delta', index: 0, text: 'the stream' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'inspect the stream' } },
    { type: 'block-start', index: 1, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 1, text: 'then verify output' },
    { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'then verify output' } },
    { type: 'usage', inputTokens: 4, outputTokens: 6 },
    finish(),
  ]
  const result = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(chunks))) result.push(chunk)

  assert.deepEqual(result, chunks)
  assert.deepEqual(mergeReasoningBlocks(result), ['inspect the stream', 'then verify output'])
})

test('completed reasoning blocks are released before later chunks finish', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness, 'reasoning-immediate-release')
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))

  const gate = deferred()
  async function* source() {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 0, text: 'release this block' }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'release this block' } }
    await gate.promise
    yield { type: 'usage', inputTokens: 2, outputTokens: 3 }
    yield finish()
  }

  const iterator = stream(mainStreamOptions(agent), () => source())[Symbol.asyncIterator]()
  assert.deepEqual((await iterator.next()).value, { type: 'block-start', index: 0, blockType: 'reasoning' })
  assert.deepEqual((await iterator.next()).value, { type: 'reasoning-delta', index: 0, text: 'release this block' })
  assert.deepEqual((await iterator.next()).value, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'release this block' } })

  gate.resolve()
  assert.deepEqual((await iterator.next()).value, { type: 'usage', inputTokens: 2, outputTokens: 3 })
  assert.deepEqual((await iterator.next()).value, finish())
  assert.equal((await iterator.next()).done, true)
})

test('a reasoning block waits for its matching block-end before release', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness, 'reasoning-matching-end')
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))

  const gate = deferred()
  async function* source() {
    yield { type: 'block-start', index: 3, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 3, text: 'do not close early' }
    await gate.promise
    yield { type: 'block-end', index: 3, block: { type: 'reasoning', text: 'do not close early' } }
    yield finish()
  }

  const iterator = stream(mainStreamOptions(agent), () => source())[Symbol.asyncIterator]()
  const pending = iterator.next()
  const early = await Promise.race([
    pending.then(() => 'emitted'),
    new Promise((resolve) => setImmediate(() => resolve('waiting'))),
  ])
  assert.equal(early, 'waiting')

  gate.resolve()
  assert.deepEqual((await pending).value, { type: 'block-start', index: 3, blockType: 'reasoning' })
  assert.deepEqual((await iterator.next()).value, { type: 'reasoning-delta', index: 3, text: 'do not close early' })
  assert.deepEqual((await iterator.next()).value, { type: 'block-end', index: 3, block: { type: 'reasoning', text: 'do not close early' } })
  assert.deepEqual((await iterator.next()).value, finish())
})

test('a buffered text prefix prevents reasoning from being reordered', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness, 'reasoning-order-barrier')
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))

  const gate = deferred()
  const visible = 'answer before reasoning'
  async function* source() {
    yield textStart(0)
    yield textDelta(visible, 0)
    yield textEnd(visible, 0)
    yield { type: 'block-start', index: 1, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: 1, text: 'must not overtake text' }
    yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'must not overtake text' } }
    await gate.promise
    yield finish()
  }

  const iterator = stream(mainStreamOptions(agent), () => source())[Symbol.asyncIterator]()
  const pending = iterator.next()
  const early = await Promise.race([
    pending.then(() => 'emitted'),
    new Promise((resolve) => setImmediate(() => resolve('waiting'))),
  ])
  assert.equal(early, 'waiting')

  gate.resolve()
  assert.deepEqual((await pending).value, textStart(0))
  assert.deepEqual((await iterator.next()).value, textDelta(visible, 0))
  assert.deepEqual((await iterator.next()).value, textEnd(visible, 0))
  assert.deepEqual((await iterator.next()).value, { type: 'block-start', index: 1, blockType: 'reasoning' })
  assert.deepEqual((await iterator.next()).value, { type: 'reasoning-delta', index: 1, text: 'must not overtake text' })
  assert.deepEqual((await iterator.next()).value, { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'must not overtake text' } })
  assert.deepEqual((await iterator.next()).value, finish())
})

test('reasoning and tool frames preserve their interleaved order', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness, 'reasoning-tool-order')
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  const callId = 'ordered-tool-call'
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))

  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'prepare the call' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'prepare the call' } },
    textStart(1),
    textDelta('<summary>prepared the call</summary>', 1),
    textEnd('<summary>prepared the call</summary>', 1),
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, id: callId, name: 'read_file', argumentsDelta: '{}' },
    { type: 'block-end', index: 2, block: { type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' } },
    { type: 'usage', inputTokens: 5, outputTokens: 7 },
    finish(),
  ]
  const result = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(chunks))) result.push(chunk)

  assert.deepEqual(result.filter((chunk) => chunk.type !== 'text-delta' && !(chunk.type === 'block-start' && chunk.blockType === 'text') && !(chunk.type === 'block-end' && chunk.block.type === 'text')), [
    chunks[0], chunks[1], chunks[2], chunks[6], chunks[7], chunks[8], chunks[9], chunks[10],
  ])
  assert.equal(result.some((chunk) => chunk.type === 'text-delta'), false)
  assert.equal(result.findIndex((chunk) => chunk.type === 'reasoning-delta'), 1)
  assert.equal(result.findIndex((chunk) => chunk.type === 'tool-call-delta'), 4)
})

test('error and aborted finish preserve buffered non-text order while hiding text', async () => {
  for (const kind of ['error', 'aborted']) {
    const harness = makeHarness({
      models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
    })
    const agent = makeAgent(harness, `ordered-failure-${kind}`)
    const preStep = harness.listeners.get('agent/pre-step')
    const stream = harness.listeners.get('llm/stream')
    const callId = `ordered-failure-call-${kind}`
    await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))

    const chunks = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'explain before calling' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'explain before calling' } },
      textStart(1),
      textDelta('hidden provider prose', 1),
      textEnd('hidden provider prose', 1),
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: callId, name: 'read_file', argumentsDelta: '{}' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' } },
      { type: 'usage', inputTokens: 5, outputTokens: 7 },
      finish(kind),
    ]
    const result = []
    for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(chunks))) result.push(chunk)

    assert.equal(textFrom(result), '')
    assert.deepEqual(result.filter((chunk) => chunk.type !== 'finish' && !(chunk.type === 'block-start' && chunk.blockType === 'text') && !(chunk.type === 'block-end' && chunk.block.type === 'text')), [
      chunks[0], chunks[1], chunks[2], chunks[6], chunks[7], chunks[8], chunks[9],
    ])
    assert.equal(result.at(-1).reason.kind, kind)
  }
})

test('no-tool summary-looking text is preserved instead of being parsed', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 1, step: 2 }, async () => ({ kind: 'enter', messages: [] }))

  const result = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf([
    textStart(),
    textDelta('<summary>only hidden summary</summary>', 0),
    textEnd('<summary>only hidden summary</summary>', 0),
    finish(),
  ]))) result.push(chunk)

  const literal = '<summary>only hidden summary</summary>'
  assert.equal(textFrom(result), literal)
  assert.equal(result.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'text'), true)
  assert.equal(result.some((chunk) => chunk.type === 'text-delta' && chunk.text === literal), true)
  assert.equal(result.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text === literal), true)
})

test('selected tool steps remove the canonical tag and inject one relay only after durable tool result commit', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  const toolResult = harness.listeners.get('tools/result')
  const callId = 'call-1'
  const chunks = [
    textStart(0),
    textDelta('<summary>inspected the workspace</summary>\nNext, call the tool.', 0),
    textEnd('<summary>inspected the workspace</summary>\nNext, call the tool.', 0),
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: callId, name: 'read_file', argumentsDelta: '{"path":"x"}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"x"}' } },
    finish(),
  ]
  await preStep({ agent, turn: 2, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const result = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(chunks))) result.push(chunk)

  assert.equal(textFrom(result), '')
  assert.equal(result.some((chunk) => chunk.type === 'text-delta'), false)
  assert.equal(result.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'text'), false)
  assert.equal(result.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text'), false)

  appendAssistant(agent, 2, 1, [
    { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"x"}' },
  ])
  toolResult({ agent, callId, parent: undefined }, { concludesTurn: undefined })
  assert.equal(harness.injected.length, 0)

  appendToolResult(agent, 2, 1, callId)
  assert.equal(harness.injected.length, 0)
  await flushMicrotasks()
  assert.equal(harness.injected.length, 1)
  const relay = harness.injected[0]
  assert.equal(relay.role, 'user')
  // `source.kind` must stay 'plugin': this is a cross-plugin contract, not
  // cosmetics. dsh-repeat-tool-reminder clears its per-agent repeat chain on
  // `agent/pre-step` when any inbox message satisfies
  // `message.source.kind === 'user'` (dsh-repeat-tool-reminder/lib/index.js:1510),
  // so a relay or notice claiming to be a user message would silently reset the
  // 3/5/8-repeat reminders for the rest of the session. The `role: 'user'` above
  // is the LLM role and is unrelated — `createUserMessage` spreads the caller's
  // input and forces only `role` (dsh-llm/lib/types/message.js:45), so the
  // source passed here survives verbatim. See the notice assertion earlier in
  // this file for the same invariant.
  assert.equal(relay.source.kind, 'plugin')
  assert.equal(relay.source.plugin, 'reasoning-summary')
  assert.equal(relay.source.form, 'relay')
  // The relay carries only the tag content; the natural prose after the tag
  // is suppressed tool-step text and is never merged into the summary.
  assert.equal(relay.content[0].text, '[Action summary]\ninspected the workspace')
  assert.doesNotMatch(relay.content[0].text, /<summary|source=|turn=|step=|Reasoning summary history/)
  assert.equal(relayEvents(agent.session).length, 0)

  const preStep2 = harness.listeners.get('agent/pre-step')
  const decision = await preStep2({ agent, turn: 2, step: 2 }, async () => ({
    kind: 'enter',
    messages: agent.takeInbox(),
  }))
  assert.equal(decision.messages.length, 1)
  assert.strictEqual(decision.messages[0], relay)
  agent.session.append('user/message', relay, { surfaceOp: 'append' })
  assert.equal(relayEvents(agent.session).length, 1)
})

test('untagged tool-step prose is hidden and reports missing instead of inferring', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  const toolResult = harness.listeners.get('tools/result')
  const callId = 'call-untagged'
  await preStep({ agent, turn: 8, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const result = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf([
    textStart(0),
    textDelta('Read src/index.ts, confirmed the parser location, and will update the nearest-pair regression.', 0),
    textEnd('Read src/index.ts, confirmed the parser location, and will update the nearest-pair regression.', 0),
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: callId, name: 'read_file', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' } },
    finish(),
  ]))) result.push(chunk)

  assert.equal(textFrom(result), '')
  assert.equal(result.some((chunk) => chunk.type === 'text-delta'), false)
  appendAssistant(agent, 8, 1, [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' }])
  toolResult({ agent, callId, parent: undefined }, { concludesTurn: true })
  appendToolResult(agent, 8, 1, callId)
  await flushMicrotasks()

  const relay = relayMessages(agent.session)[0]
  // Untagged visible prose is never promoted to a summary: the relay is the
  // missing reminder, not the model's own words.
  assert.equal(
    relay.content[0].text,
    `[Action summary: missing]\n${MISSING_TEXT}`,
  )
  assert.doesNotMatch(relay.content[0].text, /source=|turn=|step=|Reasoning summary history/)
  // The reminder states both discard rules the model must act on: reasoning
  // content is unread, and visible text outside the tag is discarded.
  assert.match(relay.content[0].text, /reasoning\/thinking content is never read/)
  assert.match(relay.content[0].text, /text outside the tag is discarded/)
  // The only literal tag permitted is the intentional <summary>...</summary>
  // template embedded in MISSING_TEXT; the model's own prose and tags are gone.
  const templateTags = (MISSING_TEXT.match(/<summary/g) ?? []).length
  assert.equal((relay.content[0].text.match(/<summary/g) ?? []).length, templateTags)
})

test('partial and missing tool summaries retain only compact degraded-status headers', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness, 'degraded-summary-headers')
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  const toolResult = harness.listeners.get('tools/result')

  const cases = [
    {
      step: 1,
      callId: 'partial-summary',
      text: '<summary>the model was still collecting evidence',
      expected: `[Action summary: partial]\nthe model was still collecting evidence\n\n${PARTIAL_TEXT}`,
    },
    {
      step: 2,
      callId: 'missing-summary',
      text: '',
      expected: `[Action summary: missing]\n${MISSING_TEXT}`,
    },
  ]

  for (const entry of cases) {
    await preStep({ agent, turn: 12, step: entry.step }, async () => ({ kind: 'enter', messages: [] }))
    const chunks = [
      ...(entry.text === '' ? [] : [textStart(0), textDelta(entry.text, 0), textEnd(entry.text, 0)]),
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: entry.callId, name: 'read_file', argumentsDelta: '{}' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: entry.callId, name: 'read_file', arguments: '{}' } },
      finish(),
    ]
    const output = await collectStream(stream(mainStreamOptions(agent), () => streamOf(chunks)))
    assert.equal(textFrom(output), '')
    appendAssistant(agent, 12, entry.step, [{ type: 'tool-call', id: entry.callId, name: 'read_file', arguments: '{}' }])
    toolResult({ agent, callId: entry.callId, parent: undefined }, { concludesTurn: true })
    appendToolResult(agent, 12, entry.step, entry.callId)
    await flushMicrotasks()
  }

  const relays = relayMessages(agent.session)
  assert.deepEqual(relays.map((relay) => relay.content[0].text), cases.map((entry) => entry.expected))
  for (const relay of relays) {
    const text = relay.content[0].text
    // Degraded relays stay compact: no provenance metadata and no copy of any
    // model-supplied tag or content. The only literal tag permitted is the
    // intentional <summary>...</summary> template embedded in MISSING_TEXT.
    assert.doesNotMatch(text, /source=|turn=|step=|Reasoning summary history/)
    const templateTags = (MISSING_TEXT.match(/<summary/g) ?? []).length
    assert.equal((text.match(/<summary/g) ?? []).length, text.includes(MISSING_TEXT) ? templateTags : 0)
  }
})

test('a late summary and all tool-step prose are hidden without reordering provider blocks', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 5, step: 2 }, async () => ({ kind: 'enter', messages: [] }))
  const chunks = [
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call-late', name: 'read_file', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-late', name: 'read_file', arguments: '{}' } },
    textStart(0),
    textDelta('<summary>discovered the required file</summary> after the tool', 0),
    textEnd('<summary>discovered the required file</summary> after the tool', 0),
    finish(),
  ]
  const result = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(chunks))) result.push(chunk)
  const firstText = result.findIndex((chunk) => chunk.type === 'text-delta')
  const firstTool = result.findIndex((chunk) => chunk.type === 'tool-call-delta')
  assert.ok(firstTool >= 0)
  assert.equal(firstText, -1)
  assert.equal(textFrom(result), '')
  assert.equal(result.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'text'), false)
  assert.equal(result.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text'), false)
})

test('block-end-only tool-step text streams are hidden after removing the first summary', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 6, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const result = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf([
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call-end-only', name: 'read_file', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-end-only', name: 'read_file', arguments: '{}' } },
    textEnd('<summary>read the file metadata</summary> then call the tool', 0),
    finish(),
  ]))) result.push(chunk)
  const textEndChunk = result.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')
  assert.equal(textEndChunk, undefined)
  assert.equal(textFrom(result), '')
  assert.equal(result.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'text'), false)
})

test('final output preserves literal summary markup without parsing or relaying it', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 3, step: 3 }, async () => ({ kind: 'enter', messages: [] }))
  const finalText = '<summary>final response was prepared</summary>\nHere is the final answer.'
  const result = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf([
    textStart(),
    textDelta(finalText, 0),
    textEnd(finalText, 0),
    finish(),
  ]))) result.push(chunk)

  assert.equal(textFrom(result), finalText)
  assert.equal(harness.injected.length, 0)
  assert.equal(relayEvents(agent.session).length, 0)

  appendAssistant(agent, 3, 3, [{ type: 'text', text: finalText }])
  assert.equal(agent.session.events.some((event) => event.type === 'assistant/message' && event.data.message.content.length === 0), false)
  assert.equal(agent.session.deriveMessages().some((message) => message.role === 'assistant' && message.content[0]?.text === finalText), true)
})

test('durable final text containing literal summary markup does not trigger continuation', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  await preStep({ agent, turn: 3, step: 4 }, async () => ({ kind: 'enter', messages: [] }))
  const finalText = '<summary>literal documentation example</summary>'
  appendAssistant(agent, 3, 4, [
    { type: 'reasoning', text: 'The answer is ready.' },
    { type: 'text', text: finalText },
  ])
  await flushMicrotasks()

  assert.equal(harness.injected.length, 0)
  assert.equal(harness.steered.length, 0)
  assert.equal(agent.session.deriveMessages().some((message) => message.role === 'assistant' && message.content.some((block) => block.type === 'text' && block.text === finalText)), true)
})

test('a concluded tool turn persists a final relay for every later route', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  await admitRoute(harness, agent, {
    provider: 'cotton-codex', model: 'gpt-5.6-luna', turn: 7, step: 1,
  })
  await completeConcludedToolStep(harness, agent, {
    turn: 7, step: 1, summary: 'the tool completed the requested operation', callId: 'call-concluded',
  })

  const relays = relayEvents(agent.session)
  assert.equal(relays.length, 1)
  assert.equal(agent.session.events.some((event) => event.type === 'assistant/message'
    && event.data.message.content.length === 0), false)
  assert.equal(agent.session.deriveMessages().some((message) => message.source?.form === 'relay'), true)

  harness.updateSettings({ models: [] })
  agent.options.provider = 'bailian'
  agent.options.model = 'deepseek-v4-flash'
  const preStep = harness.listeners.get('agent/pre-step')
  await preStep({ agent, turn: 8, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(agent.session.deriveMessages().some((message) => message.id === relays[0].data.id), true)
  assert.equal(agent.session.deriveMessages().some((message) => message.source?.form === 'relay'), true)
})

test('a terminal relay survives step/end winning the durable-result microtask race', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  await admitRoute(harness, agent, {
    provider: 'cotton-codex', model: 'gpt-5.6-luna', turn: 40, step: 1,
  })
  const stream = harness.listeners.get('llm/stream')
  const toolResult = harness.listeners.get('tools/result')
  const callId = 'race-concluded'
  for await (const _chunk of stream(mainStreamOptions(agent), () => streamOf([
    textStart(),
    textDelta('<summary>preserved the result before the step closed</summary>', 0),
    textEnd('<summary>preserved the result before the step closed</summary>', 0),
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: callId, name: 'read_file', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' } },
    finish(),
  ]))) {}
  appendAssistant(agent, 40, 1, [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' }])
  toolResult({ agent, callId, parent: undefined }, { concludesTurn: true })
  appendToolResult(agent, 40, 1, callId)
  agent.session.append('step/end', { turn: 40, step: 1 })
  await flushMicrotasks()

  assert.equal(relayEvents(agent.session).length, 1)
  assert.equal(relayMessages(agent.session).length, 1)
})

test('duplicate durable tool results cannot release a second relay', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  const toolResult = harness.listeners.get('tools/result')
  const callId = 'call-once'
  await preStep({ agent, turn: 8, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  for await (const _chunk of stream(mainStreamOptions(agent), () => streamOf([
    textStart(),
    textDelta('<summary>recorded one tool result</summary>', 0),
    textEnd('<summary>recorded one tool result</summary>', 0),
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: callId, name: 'read_file', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' } },
    finish(),
  ]))) {}
  appendAssistant(agent, 8, 1, [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' }])
  toolResult({ agent, callId, parent: undefined }, { concludesTurn: undefined })
  appendToolResult(agent, 8, 1, callId)
  appendToolResult(agent, 8, 1, callId, 'duplicate event')
  await flushMicrotasks()
  assert.equal(harness.injected.length, 1)
  assert.equal(relayEvents(agent.session).length, 0)
})

// ---------------------------------------------------------------------------
// Cross-plugin contract: dsh-repeat-tool-reminder's repeat chain
//
// The guard clears its per-agent chain when the batch handed to `agent/pre-step`
// contains any message with `source.kind === 'user'`
// (dsh-repeat-tool-reminder/lib/index.js:1510). Everything this plugin puts in
// that batch must therefore stay `kind: 'plugin'`, or it would silently reset
// the 3/5/8-repeat reminders for the rest of the session.
//
// These tests run the REAL guard, not a transcription of its rule. It needs only
// `ctx.on` and its config (dsh-repeat-tool-reminder/lib/index.js:1450-1512), so
// a two-line ctx is enough to install it next to this plugin.
// ---------------------------------------------------------------------------

const REMINDER_CONFIG = { thresholds: [3, 5, 8], include: [], exclude: [], argumentsPreviewChars: 500 }

/** Install the real guard over a minimal `ctx.on` capture; returns its handlers. */
function installRepeatToolReminder(config = REMINDER_CONFIG) {
  const handlers = new Map()
  applyRepeatToolReminder({
    on: (event, listener) => {
      handlers.set(event, listener)
      return () => {}
    },
  }, config)
  return handlers
}

/**
 * One `tools/post-execute` pass. The host dispatches this waterfall with the
 * default `() => Promise.resolve({ kind: 'accept' })`
 * (dsh-tools/lib/index.js:3378), so that is what `next()` returns here.
 */
async function attemptTool(handlers, agent, name, args) {
  const decision = await handlers.get('tools/post-execute')(
    { agent, name, arguments: args },
    undefined,
    async () => ({ kind: 'accept' }),
  )
  return decision.additionalContexts ?? []
}

/**
 * Hand the guard the batch the loop would: `messages: claimed`, i.e. exactly what
 * `agent/pre-step` receives (dsh-agent-loop/lib/index.js:911-912).
 */
async function claimIntoPreStep(handlers, agent) {
  const messages = agent.takeInbox()
  await handlers.get('agent/pre-step')(
    { agent, messages, turn: 1, step: 1, signal: undefined },
    async () => ({ kind: 'enter', messages }),
  )
  return messages
}

/** Drive one tool step whose summary is delivered into the next-step inbox. */
async function injectRelayThroughToolStep(harness, agent, turn, step) {
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  const toolResult = harness.listeners.get('tools/result')
  const callId = `call-${turn}-${step}`
  await preStep({ agent, turn, step }, async () => ({ kind: 'enter', messages: [] }))
  for await (const _chunk of stream(mainStreamOptions(agent), () => streamOf([
    textStart(),
    textDelta('<summary>inspected the workspace</summary>', 0),
    textEnd('<summary>inspected the workspace</summary>', 0),
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: callId, name: 'read_file', argumentsDelta: '{"path":"x"}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"x"}' } },
    finish(),
  ]))) {}
  appendAssistant(agent, turn, step, [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"x"}' }])
  toolResult({ agent, callId, parent: undefined }, { concludesTurn: undefined })
  appendToolResult(agent, turn, step, callId)
  await flushMicrotasks()
}

test('the next-step relay keeps the repeat-tool reminder chain alive', async () => {
  const handlers = installRepeatToolReminder()
  const harness = makeHarness({ models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }] })
  const agent = makeAgent(harness)
  await admitRoute(harness, agent, { provider: 'cotton-codex', model: 'gpt-5.6-luna', turn: 2, step: 1 })
  await injectRelayThroughToolStep(harness, agent, 2, 1)
  assert.equal(harness.injected.length, 1, 'the relay must reach the inbox for this test to mean anything')

  // Two identical attempts leave the chain at 2: below the first threshold.
  assert.deepEqual(await attemptTool(handlers, agent, 'read_file', { path: 'x' }), [])
  assert.deepEqual(await attemptTool(handlers, agent, 'read_file', { path: 'x' }), [])

  // The next step claims the plugin's relay — this is the batch the guard scans.
  const claimed = await claimIntoPreStep(handlers, agent)
  const mine = claimed.filter((message) => message.source?.plugin === 'reasoning-summary')
  assert.equal(mine.length, 1)
  assert.equal(mine[0].source.kind, 'plugin')
  assert.equal(claimed.some((message) => message.source?.kind === 'user'), false)

  // A third identical attempt is still the third in the run, so the guard fires.
  const contexts = await attemptTool(handlers, agent, 'read_file', { path: 'x' })
  assert.equal(contexts.length, 1)
  assert.match(contexts[0].content[0].text, /^You are repeating the exact same tool call/)
  assert.equal(contexts[0].source.kind, 'plugin')
})

test('control: a user-sourced message in that same batch does reset the chain', async () => {
  const handlers = installRepeatToolReminder()
  const harness = makeHarness({ models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }] })
  const agent = makeAgent(harness)

  assert.deepEqual(await attemptTool(handlers, agent, 'read_file', { path: 'x' }), [])
  assert.deepEqual(await attemptTool(handlers, agent, 'read_file', { path: 'x' }), [])

  // Same batch size as the test above, differing in exactly one respect: the
  // source kind. If this did not reset the chain, the test above would pass for
  // the wrong reason (the reset path never running at all).
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: 'stop repeating that call' }],
    source: { kind: 'user' },
  }))
  const claimed = await claimIntoPreStep(handlers, agent)
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].source.kind, 'user')

  assert.deepEqual(await attemptTool(handlers, agent, 'read_file', { path: 'x' }), [])
})

test('two complete summaries without a tool call release the step and inject the plugin notice', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))

  const chunks = [
    textStart(0),
    textDelta('<summary>first planned action</summary>', 0),
    textEnd('<summary>first planned action</summary>', 0),
    textStart(1),
    textDelta('<summary>second planned action</summary>', 1),
    textEnd('<summary>second planned action</summary>', 1),
    finish(),
  ]
  const output = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(chunks))) output.push(chunk)

  // A released step keeps its passthrough order; text is flushed early rather
  // than withheld until finish, so the user can see the spin and interrupt.
  assert.deepEqual(output, chunks)
  // The plugin's own notice is queued for the next step — never one of the
  // model's unexecuted summaries.
  assert.equal(harness.injected.length, 1)
  const notice = harness.injected[0]
  assert.equal(notice.source.kind, 'plugin')
  assert.equal(notice.source.form, 'notice')
  assert.match(notice.content[0].text, /^\[No tool call received\]\n/)
  assert.match(notice.content[0].text, /DSH executes tools only when the assistant emits structured DSH tool-call blocks\. Text that imitates a tool invocation is ordinary assistant text and is not executed\./)
  assert.doesNotMatch(notice.content[0].text, /first planned action|second planned action/)
  // A released non-tool step produces no action-summary relay.
  assert.equal(relayEvents(agent.session).length, 0)
  assert.equal(relayMessages(agent.session).length, 0)
  assert.equal(harness.steered.length, 0)
})

test('spin suppression keeps later steps transparent until a non-spin tool succeeds', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const harness = makeHarness({ models: [route] })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')

  await admitRoute(harness, agent, { ...route, turn: 1, step: 1 })
  const spinChunks = [
    textStart(0),
    textDelta('<summary>first spin plan</summary>', 0),
    textEnd('<summary>first spin plan</summary>', 0),
    textStart(1),
    textDelta('<summary>second spin plan</summary>', 1),
    textEnd('<summary>second spin plan</summary>', 1),
    finish(),
  ]
  const spinOutput = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(spinChunks))) spinOutput.push(chunk)
  assert.deepEqual(spinOutput, spinChunks)
  harness.emitSessionEvent(agent.session, {
    type: 'assistant/message',
    time: Date.now(),
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'spin released' }] } },
  })
  harness.emitSessionEvent(agent.session, {
    type: 'step/end',
    time: Date.now(),
    data: { turn: 1, step: 1 },
  })
  await flushMicrotasks()
  assert.equal(harness.injected.length, 1)
  assert.match(harness.injected[0].content[0].text, /^\[No tool call received\]/)

  const notice = agent.takeInbox()
  const second = await admitRoute(harness, agent, {
    ...route, turn: 1, step: 2, messages: notice,
  })
  assert.equal(second.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  const secondChunks = [textStart(), textDelta('transparent after spin'), textEnd('transparent after spin'), finish()]
  const secondResult = await completeTransparentStep(harness, agent, {
    turn: 1, step: 2, chunks: secondChunks,
  })
  assert.deepEqual(secondResult.output, secondChunks)

  const third = await admitRoute(harness, agent, { ...route, turn: 1, step: 3 })
  assert.equal(third.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  const thirdChunks = [
    textStart(0),
    textDelta('<summary>still spinning without a tool</summary>', 0),
    textEnd('<summary>still spinning without a tool</summary>', 0),
    textStart(1),
    textDelta('<summary>still planning without a tool</summary>', 1),
    textEnd('<summary>still planning without a tool</summary>', 1),
    finish(),
  ]
  const thirdResult = await completeTransparentStep(harness, agent, {
    turn: 1, step: 3, chunks: thirdChunks,
  })
  assert.deepEqual(thirdResult.output, thirdChunks)

  const recovery = await admitRoute(harness, agent, { ...route, turn: 1, step: 4 })
  assert.equal(recovery.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  const recoveredTool = await completeConcludedToolStep(harness, agent, {
    turn: 1, step: 4, summary: 'a non-spin tool step clears suppression', callId: 'spin-recovery',
  })
  assert.deepEqual(recoveredTool.output, recoveredTool.chunks)
  assert.equal(relayMessages(agent.session).length, 0)

  const active = await admitRoute(harness, agent, { ...route, turn: 1, step: 5 })
  assert.match(active.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, /Tool-step communication protocol/)
})

test('a failed recovery tool step keeps spin suppression active', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const harness = makeHarness({ models: [route] })
  const agent = makeAgent(harness)
  const stream = harness.listeners.get('llm/stream')

  await admitRoute(harness, agent, { ...route, turn: 1, step: 1 })
  const spinChunks = [
    textStart(0),
    textDelta('<summary>first failed plan</summary>', 0),
    textEnd('<summary>first failed plan</summary>', 0),
    textStart(1),
    textDelta('<summary>second failed plan</summary>', 1),
    textEnd('<summary>second failed plan</summary>', 1),
    finish(),
  ]
  for await (const _chunk of stream(mainStreamOptions(agent), () => streamOf(spinChunks))) {}
  harness.emitSessionEvent(agent.session, {
    type: 'assistant/message',
    time: Date.now(),
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'spin released' }] } },
  })
  harness.emitSessionEvent(agent.session, { type: 'step/end', time: Date.now(), data: { turn: 1, step: 1 } })
  agent.takeInbox()

  const failedRecovery = await admitRoute(harness, agent, { ...route, turn: 1, step: 2 })
  assert.equal(failedRecovery.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')
  emitRuntimeToolLifecycle(harness, agent, { turn: 1, step: 2, callId: 'failed-recovery', error: true })

  const stillSuppressed = await admitRoute(harness, agent, { ...route, turn: 1, step: 3 })
  assert.equal(stillSuppressed.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, '')

  await completeConcludedToolStep(harness, agent, {
    turn: 1, step: 3, summary: 'the later recovery tool completed', callId: 'successful-recovery',
  })
  const active = await admitRoute(harness, agent, { ...route, turn: 1, step: 4 })
  assert.match(active.assembly.contexts.find((context) => context.name === 'reasoning-summary:instruction').text, /Tool-step communication protocol/)
})

test('summaries beside a real tool call do not trigger the spin release', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))

  const chunks = [
    textStart(0),
    textDelta('<summary>first planned action</summary>', 0),
    textEnd('<summary>first planned action</summary>', 0),
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'read_file', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{}' } },
    textStart(2),
    textDelta('<summary>second planned action</summary>', 2),
    textEnd('<summary>second planned action</summary>', 2),
    finish(),
  ]
  const output = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(chunks))) output.push(chunk)

  // A real executed call keeps the step on the normal path: no spin release,
  // no notice, and the tool step's prose stays hidden.
  assert.equal(harness.injected.length, 0)
  assert.equal(harness.steered.length, 0)
  assert.equal(output.some((chunk) => chunk.type === 'text-delta'), false)
  assert.ok(output.some((chunk) => chunk.type === 'finish'))
})

test('a single summary without a tool call neither releases nor injects', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  await preStep({ agent, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))

  const chunks = [
    textStart(0),
    textDelta('<summary>only planned action</summary>', 0),
    textEnd('<summary>only planned action</summary>', 0),
    finish(),
  ]
  const output = []
  for await (const chunk of stream(mainStreamOptions(agent), () => streamOf(chunks))) output.push(chunk)

  assert.deepEqual(output, chunks)
  assert.equal(harness.injected.length, 0)
  assert.equal(harness.steered.length, 0)
  assert.equal(relayEvents(agent.session).length, 0)
})
