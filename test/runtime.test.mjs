import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply, MISSING_TEXT, PARTIAL_TEXT } from '../lib/index.js'

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
  const sections = []
  const appended = []
  const injected = []
  const steered = []
  const agentById = new Map()
  let currentConfig = config
  let settingsWatcher
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
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
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

  return {
    listeners,
    sections,
    appended,
    injected,
    steered,
    agentById,
    createTestSession,
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
      { name: 'reasoning-summary:instruction', text: 'placeholder' },
      { name: 'other-plugin:section', text: 'keep this section' },
    ],
    contexts: [],
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
  return { assembly, decision }
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
  await flushMicrotasks()
  return { chunks, output }
}

test('the system prompt is present only for the selected exact route', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const section = harness.sections[0]
  const selected = { options: { provider: 'cotton-codex', model: 'gpt-5.6-luna' } }
  const other = { options: { provider: 'cotton', model: 'gpt-5.6-luna' } }
  assert.match(section.text({ agent: selected }), /Tool-step communication protocol/)
  assert.match(section.text({ agent: selected }), /exactly one literal XML-style summary tag immediately before the first tool call/)
  assert.match(section.text({ agent: selected }), /emit no ordinary assistant prose outside that tag/)
  assert.match(section.text({ agent: selected }), /specific and actionable/)
  assert.equal(section.text({ agent: other }), '')
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
  assert.equal(disabledAssembly.sections.find((section) => section.name === 'reasoning-summary:instruction').text, '')
  const disabledDecision = await preStep({ agent, turn: 20, step: 1 }, async () => ({
    kind: 'enter', messages: [stale.data, external.data],
  }))
  assert.deepEqual(disabledDecision.messages.map((message) => message.id), [stale.data.id, external.data.id])
  assert.equal(agent.session.deriveMessages().some((message) => message.id === stale.data.id), true)
  assert.equal(agent.session.events.some((event) => event.surfaceOp?.op === 'replace'), false)

  const enabledAssembly = await assembleWithRoute(harness, agent, 'cotton-codex', 'gpt-5.6-luna')
  assert.match(enabledAssembly.sections.find((section) => section.name === 'reasoning-summary:instruction').text, /Tool-step communication protocol/)
  assert.match(harness.sections[0].text({ agent }), /Tool-step communication protocol/)
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
  assert.equal(harness.sections[0].text({ agent }), '')
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
  assert.equal(harness.sections[0].text({ agent }), '')
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
    turn: 3, step: 1, summary: 'A completed the next workspace action', callId: 'a-2',
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
    turn: 3, step: 1, summary: 'C added the second history entry', callId: 'abcd-c',
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
  await completeConcludedToolStep(harness, agent, {
    turn: 2, step: 1, summary: 'A created the first summary after switching', callId: 'switch-a',
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
  assert.equal(continuation.source.kind, 'plugin')
  assert.equal(continuation.source.form, 'notice')
  assert.ok(continuation.content[0].text.trim().length > 0)
  assert.match(continuation.content[0].text, /^\[Continue after reasoning-only response\]\n/)
  assert.match(continuation.content[0].text, /Continue the task now/)
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
  assert.equal(harness.sections[0].text({ agent }), '')

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
    assert.match(source, /e\('li', \{\s*className: `rs-card/)
    assert.match(source, /\.rs-card \{[^}]*border:\s*1px solid var\(--dsw-alias-border-l2\)/)
    assert.match(source, /\.rs-card \{[^}]*border-radius:\s*12px/)
    assert.doesNotMatch(source, /\.rs-card \{[^}]*overflow\s*:/)
    assert.doesNotMatch(source, /border-left:\s*3px/)
    assert.doesNotMatch(source, /['"]⌄['"]/) 
    assert.match(source, /IconChevronDownOutline14/)
    assert.doesNotMatch(source, /rs-select(?:-chevron)?/)
    assert.doesNotMatch(source, /e\('select'/)
    assert.match(source, /\.rs-model-label \{[^}]*font-weight:\s*500;\s*line-height:\s*1\.5/)
    assert.match(source, /\.rs-row \{[^}]*min-height:\s*32px;[^}]*padding:\s*2px 8px/)
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
  assert.equal(relay.source.kind, 'plugin')
  assert.equal(relay.source.plugin, 'reasoning-summary')
  assert.equal(relay.source.form, 'relay')
  assert.equal(relay.content[0].text, '[Action summary]\ninspected the workspace\nNext, call the tool.')
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

test('untagged tool-step prose is hidden and retained as an inferred relay summary', async () => {
  const harness = makeHarness({
    models: [{ provider: 'cotton-codex', model: 'gpt-5.6-luna' }],
  })
  const agent = makeAgent(harness)
  const preStep = harness.listeners.get('agent/pre-step')
  const stream = harness.listeners.get('llm/stream')
  const toolResult = harness.listeners.get('tools/result')
  const callId = 'call-inferred'
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
  assert.equal(
    relay.content[0].text,
    '[Action summary: inferred]\nRead src/index.ts, confirmed the parser location, and will update the nearest-pair regression.',
  )
  assert.doesNotMatch(relay.content[0].text, /<summary|source=|turn=|step=|Reasoning summary history/)
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
  for (const relay of relays) assert.doesNotMatch(relay.content[0].text, /<summary|source=|turn=|step=|Reasoning summary history/)
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
