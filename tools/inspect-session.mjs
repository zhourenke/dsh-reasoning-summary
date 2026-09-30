#!/usr/bin/env node
/**
 * Inspect one Session's durable log and report what this plugin did in it.
 *
 * The browser face of @zhourenke/dsh-reasoning-summary leaves no visible trace:
 * Host 0.2.0-rc.2 renders no chat row for a text-only injected context
 * (dsh-client-ui-chat/lib/client.js `isVisibleChatNode`), and it never renders a
 * `system-prompt` node at all. So "the UI shows nothing" is not evidence that the
 * plugin is idle — the durable log is. This tool reads that log and answers:
 * was the Session's route among the configured ones, was the protocol context
 * injected exactly once, and what did each step publish?
 *
 * Usage:
 *   node tools/inspect-session.mjs                 # the Session running this shell
 *   node tools/inspect-session.mjs <session-id>    # `session-<uuid>` or a bare uuid
 *   node tools/inspect-session.mjs <path>          # *.jsonl, *.jsonl.zstd, *.zip
 *   node tools/inspect-session.mjs <id> --json     # machine-readable report
 *
 * Exit codes: 0 the plugin acted in this Session; 1 it did not; 2 the log could
 * not be read. A Session whose route is not configured is expected to report 1.
 *
 * Log formats. The live log is `session.v4.jsonl.zstd` — a *stream of concatenated
 * zstd frames*, one per append, which neither `zstdDecompressSync` nor the
 * streaming decoder walks past the first frame, so frames are located by their
 * magic number and decompressed one by one (verified byte-identical to the
 * decompressed export of the same Session). The `.zip` export is a single
 * streamed entry whose local header carries no sizes, so its deflate stream is
 * delimited by the trailing data descriptor.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { inflateRawSync, zstdDecompressSync } from 'node:zlib'

/** The kind every message of this plugin carries in `source.kind`. */
const SOURCE_KIND = 'reasoning-summary'
const PACKAGE_NAME = '@zhourenke/dsh-reasoning-summary'
/** Relay headers, from `normalizeSummaryContent` in src/index.ts. */
const RELAY_HEADERS = [
  { status: 'complete', prefix: '[Action summary]' },
  { status: 'partial', prefix: '[Action summary: partial]' },
  { status: 'missing', prefix: '[Action summary: missing]' },
]
const CONTINUATION_PREFIX = '[Continue after reasoning-only response]'
const SPIN_NOTICE_PREFIX = '[No tool call received]'
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ZIP_LOCAL_HEADER = 0x04034b50
const ZIP_DATA_DESCRIPTOR = Buffer.from([0x50, 0x4b, 0x07, 0x08])

function fail(message) {
  console.error(`inspect-session: ${message}`)
  process.exit(2)
}

/** A target is a path when it has a separator or a log/export extension. */
function looksLikePath(target) {
  return target.includes('/') || target.includes('\\') || /\.(jsonl|zst|zstd|zip)$/i.test(target)
}

/** Decompress a log written as concatenated zstd frames. */
function decodeZstdFrames(buffer) {
  const offsets = []
  for (let at = buffer.indexOf(ZSTD_MAGIC); at !== -1; at = buffer.indexOf(ZSTD_MAGIC, at + 4)) offsets.push(at)
  if (offsets.length === 0) return buffer
  const parts = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    // A magic-number byte pair can occur inside compressed data; such a false
    // boundary makes the frame fail, and the frame then extends to the next
    // candidate boundary instead.
    for (let cursor = index; ; cursor += 1) {
      const end = cursor + 1 < offsets.length ? offsets[cursor + 1] : buffer.length
      try {
        parts.push(zstdDecompressSync(buffer.subarray(start, end)))
        index = cursor
        break
      } catch (error) {
        if (cursor + 1 >= offsets.length) throw error
      }
    }
  }
  return Buffer.concat(parts)
}

/** Read the single streamed entry of a Session export. */
function decodeExportZip(buffer) {
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== ZIP_LOCAL_HEADER) throw new Error('not a zip local file header')
  const method = buffer.readUInt16LE(8)
  const start = 30 + buffer.readUInt16LE(26) + buffer.readUInt16LE(28)
  let size = buffer.readUInt32LE(18)
  if (size > 0) return inflateEntry(buffer.subarray(start, start + size), method)
  // Sizes were streamed into a trailing data descriptor, so the compressed
  // stream ends where that descriptor begins.
  for (let at = buffer.indexOf(ZIP_DATA_DESCRIPTOR, start); at !== -1; at = buffer.indexOf(ZIP_DATA_DESCRIPTOR, at + 4)) {
    try {
      return inflateEntry(buffer.subarray(start, at), method)
    } catch (error) {
      // Not this occurrence; keep scanning.
    }
  }
  throw new Error('no complete entry found (unzip the export and pass the .jsonl instead)')
}

function inflateEntry(bytes, method) {
  if (method === 0) return bytes
  if (method === 8) return inflateRawSync(bytes)
  throw new Error(`unsupported zip compression method ${method}`)
}

function readLogText(path) {
  const bytes = readFileSync(path)
  if (path.endsWith('.zip')) return decodeExportZip(bytes).toString('utf8')
  if (path.endsWith('.zstd')) return decodeZstdFrames(bytes).toString('utf8')
  return bytes.toString('utf8')
}

/** Locate a Session's live log under the harness home. */
function findLiveLog(sessionId, home) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return undefined
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
      const candidate = join(root, entry.name, sessionId, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Read the profile patch's routes for this plugin. This is a narrow line reader
 * for the `- id: / name: / config: / models: / - provider: / model:` shape the
 * install writes, not a YAML parser.
 */
function readConfiguredRoutes(profileDir) {
  const path = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(path)) return undefined
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const named = lines.findIndex((line) => line.includes(PACKAGE_NAME) && /^\s*name:/.test(line))
  if (named === -1) return undefined
  let id
  for (let index = named; index >= 0; index -= 1) {
    const match = /^\s*-\s*id:\s*(\S+)/.exec(lines[index])
    if (match !== null) { id = match[1]; break }
  }
  const routes = []
  let staged
  for (let index = named + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*-\s*(?:id|name):/.test(line)) break
    const provider = /^\s*-\s*provider:\s*(\S+)/.exec(line)
    if (provider !== null) { staged = { provider: provider[1], model: '' }; routes.push(staged); continue }
    const model = /^\s*model:\s*(\S+)/.exec(line)
    if (model !== null && staged !== undefined) staged.model = model[1]
  }
  return { id, routes }
}

const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((block) => block?.type === 'text' && typeof block.text === 'string')
  .map((block) => block.text)
  .join('\n')

const oneLine = (text) => text.replace(/\s+/g, ' ').trim()

/** Fold the log's events into the report the tool prints. */
function analyse(events) {
  const header = events.find((event) => event.type === 'session') ?? {}
  // The route is what the plugin is admitted against, and a Session can change it
  // mid-flight, so only the last one describes the steps running now.
  // `model/selection` is the explicit choice; a Session that never recorded one
  // (an older Host, or one that stopped before its first call) still names the
  // route it used on the request itself — reporting "nothing selected" for a
  // Session that plainly ran would be wrong, and would also mislabel it as
  // "not covered by the plugin".
  const selections = events.filter((event) => event.type === 'model/selection')
  const pickRoute = () => {
    const groups = [
      ['model/selection', selections],
      ['request/context', events.filter((event) => event.type === 'request/context')],
      ['request/header', events.filter((event) => event.type === 'request/header')],
    ]
    for (const [source, entries] of groups) {
      const last = entries.at(-1)
      const value = source === 'request/header' ? last?.data?.header?.config : last?.data
      if (typeof value?.provider === 'string' && typeof value?.model === 'string') {
        return { provider: value.provider, model: value.model, effort: value.reasoningEffort, seq: last.seq, source }
      }
    }
    return undefined
  }
  const route = pickRoute()
  const seenRoutes = []
  for (const event of selections) {
    const key = `${event.data?.provider}/${event.data?.model}`
    if (!seenRoutes.includes(key)) seenRoutes.push(key)
  }
  const plugin = { protocolContext: [], relays: [], continuations: [], spinNotices: [], other: [] }
  const splices = []

  const classify = (message, seq) => {
    const text = textOf(message?.content)
    const record = { seq, id: message?.id, form: message?.source?.form, chars: text.length, head: oneLine(text).slice(0, 120) }
    const relay = RELAY_HEADERS.find((candidate) => text.startsWith(candidate.prefix))
    if (relay !== undefined) plugin.relays.push({ ...record, status: relay.status })
    else if (text.startsWith(CONTINUATION_PREFIX)) plugin.continuations.push(record)
    else if (text.startsWith(SPIN_NOTICE_PREFIX)) plugin.spinNotices.push(record)
    else if (message?.source?.form === undefined) plugin.protocolContext.push(record)
    else plugin.other.push(record)
  }

  for (const event of events) {
    // The durable record is authoritative for what the plugin wrote, and a
    // delivery is reported separately: the host records a `next-step` splice and
    // then the message itself, so counting both would double every relay.
    if (event.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND) classify(event.data, event.seq)
    if (event.type === 'agent/inbox/spliced') {
      const inserted = Array.isArray(event.data?.inserted) ? event.data.inserted : []
      if (inserted.length > 0) {
        const ours = inserted.filter((message) => message?.source?.kind === SOURCE_KIND)
        splices.push({ seq: event.seq, target: event.data?.target, count: inserted.length, ids: ours.map((message) => message?.id) })
      }
    }
  }

  // A census over every message the log carries, deduped by id so the delivery
  // copies do not inflate it.
  const kinds = new Map()
  const counted = new Set()
  const census = (message) => {
    const id = typeof message?.id === 'string' ? message.id : undefined
    if (id !== undefined) {
      if (counted.has(id)) return
      counted.add(id)
    }
    const kind = message?.source?.kind
    if (typeof kind === 'string') kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  }
  for (const event of events) {
    if (event.type === 'user/message') census(event.data)
    if (event.type === 'assistant/message') census(event.data?.message ?? event.data)
    if (event.type === 'tool/result') census(event.data?.message ?? event.data)
    if (event.type === 'agent/inbox/spliced') for (const message of event.data?.inserted ?? []) census(message)
  }

  const count = (type) => events.filter((event) => event.type === type).length
  const durableIds = new Set([...plugin.protocolContext, ...plugin.relays, ...plugin.continuations, ...plugin.spinNotices, ...plugin.other]
    .map((record) => record.id))
  const deliveredIds = splices.flatMap((splice) => splice.ids)
  return {
    session: {
      id: header.id,
      cwd: header.cwd,
      preset: header.agentPreset,
      createdAt: typeof header.createdAt === 'number' ? new Date(header.createdAt).toISOString() : undefined,
      route: route === undefined ? undefined : `${route.provider}/${route.model}`,
      routeSeq: route?.seq,
      routeSource: route?.source,
      selections: selections.length,
      seenRoutes,
      reasoningEffort: route?.effort,
    },
    events: events.length,
    turns: count('turn/start'),
    steps: count('step/start'),
    plugin,
    delivery: {
      splices: splices.filter((splice) => splice.ids.length > 0),
      delivered: deliveredIds.length,
      // A delivery whose message never reached the durable log would mean the
      // step consumed something the transcript cannot show.
      unmatched: deliveredIds.filter((id) => !durableIds.has(id)),
    },
    kinds: Object.fromEntries([...kinds].sort((left, right) => right[1] - left[1])),
  }
}

function report(result, configured, logPath) {
  const { session, plugin } = result
  const active = plugin.protocolContext.length > 0 || plugin.relays.length > 0
  const configuredRoutes = configured === undefined ? [] : configured.routes.map((route) => `${route.provider}/${route.model}`)
  const selected = session.route !== undefined && configuredRoutes.includes(session.route)
  const routeChecked = configured !== undefined
  const lines = []
  lines.push(`session   ${session.id ?? '(unknown)'}${session.preset === undefined ? '' : ` | preset ${session.preset}`}`)
  lines.push(`created   ${session.createdAt ?? '(unknown)'}`)
  if (session.cwd !== undefined) lines.push(`cwd       ${session.cwd}`)
  lines.push(`route     ${session.route ?? '(no route recorded)'}${session.reasoningEffort === undefined ? '' : ` (effort ${session.reasoningEffort})`}${session.routeSeq === undefined ? '' : ` — as of seq ${session.routeSeq}, from ${session.routeSource}`}`)
  if (session.selections > 1) {
    lines.push(`routes    ${session.seenRoutes.join(' -> ')}   (${session.selections} selections in this Session)`)
  }
  lines.push(`log       ${logPath}`)
  lines.push(`events    ${result.events} | turns ${result.turns} | steps ${result.steps}`)
  lines.push('')

  if (routeChecked) {
    lines.push(`configured row ${configured.id ?? '?'}: ${configuredRoutes.length === 0 ? '(no route selected)' : configuredRoutes.join(', ')}`)
    const check = session.route === undefined
      ? 'no route recorded in this Session — nothing to compare'
      : selected ? 'the Session\'s current route is selected' : 'NOT selected — the plugin stays out of this Session by design'
    lines.push(`route check     ${check}`)
    lines.push('')
  } else {
    lines.push('configured row  (profile patch not found; route check skipped)')
    lines.push('')
  }

  lines.push(`plugin activity (source.kind "${SOURCE_KIND}")`)
  const context = plugin.protocolContext
  lines.push(`  protocol context  ${context.length}   ${context.length === 0 ? '(absent — the Session never admitted a selected route)' : context.map((item) => `seq ${item.seq}, ${item.chars} chars`).join('; ')}`)
  const byStatus = (status) => plugin.relays.filter((relay) => relay.status === status).length
  lines.push(`  relays            ${plugin.relays.length}   (complete ${byStatus('complete')}, partial ${byStatus('partial')}, missing ${byStatus('missing')})`)
  lines.push(`  continuations     ${plugin.continuations.length}`)
  lines.push(`  spin notices      ${plugin.spinNotices.length}`)
  if (plugin.other.length > 0) lines.push(`  other messages    ${plugin.other.length}`)
  const delivery = result.delivery
  lines.push(`  deliveries        ${delivery.delivered}   ${delivery.splices.length === 0 ? '(none)' : `spliced into ${delivery.splices.map((splice) => `${splice.target}@${splice.seq}`).join(', ')}`}`)
  if (delivery.unmatched.length > 0) {
    lines.push(`  DELIVERY PROBLEM  ${delivery.unmatched.length} delivered message(s) have no durable record: ${delivery.unmatched.join(', ')}`)
  } else if (delivery.delivered > 0) {
    lines.push(`  delivery check    every delivered message has its durable record`)
  }
  lines.push(`  kinds seen        ${Object.entries(result.kinds).map(([kind, total]) => `${kind} ${total}`).join(', ')}`)
  const legacy = Object.entries(result.kinds).filter(([kind]) => kind.startsWith('plugin:'))
  for (const [kind, total] of legacy) {
    lines.push(`  legacy shape      ${total} messages carry "${kind}", the pre-0.2.0 source shape`)
    lines.push('                    (a catch-all kind plus a plugin field). They were written by an')
    lines.push('                    older build and are deliberately not counted as activity here.')
  }
  lines.push('')
  if (active) {
    lines.push('verdict   ACTIVE — the plugin wrote to this Session; its prose is in the log,')
    lines.push('          and the chat shows no row for a text-only injected context.')
  } else if (routeChecked && session.route === undefined) {
    lines.push('verdict   INACTIVE — the log names no route at all, so no step here could have')
    lines.push('          been admitted to the plugin. Nothing to diagnose.')
  } else if (routeChecked && !selected) {
    lines.push('verdict   INACTIVE — the Session is on a route the plugin does not cover, so it')
    lines.push('          stays out by design. Nothing is broken: add the route to the row to')
    lines.push('          activate it, or read this as "not applicable to this Session".')
  } else {
    lines.push('verdict   INACTIVE — no plugin message in this Session, on a route the plugin')
    lines.push('          does cover. The protocol context is injected once per Session and each')
    lines.push('          relay follows a supervised tool step, so a Session whose steps called')
    lines.push('          no tool produces neither. A Session from before the plugin could load')
    lines.push('          at all (a peer range the startup admission gate rejects skips the whole')
    lines.push('          bundle) leaves the same empty trace.')
  }
  return { active, text: lines.join('\n') }
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?/, '').trim())
  process.exit(0)
}
const asJson = argv.includes('--json')
const target = argv.find((argument) => !argument.startsWith('-'))

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
let logPath
if (target === undefined) {
  const current = process.env.DSH_SESSION_ID
  if (current === undefined) fail('no Session given and DSH_SESSION_ID is unset; pass a Session id or a log path')
  logPath = findLiveLog(current, home)
  if (logPath === undefined) fail(`no live log for ${current} under ${join(home, 'sessions')}`)
} else if (existsSync(target)) {
  logPath = resolve(target)
} else if (looksLikePath(target)) {
  // A path that does not exist must not be reinterpreted as a Session id: the
  // resulting "no live log for session-<path>" hides the real problem.
  fail(`no such log file: ${resolve(target)}`)
} else {
  const id = target.startsWith('session-') ? target : `session-${target}`
  logPath = findLiveLog(id, home)
  if (logPath === undefined) fail(`no live log for ${id}; pass the exported .jsonl or .zip path instead`)
}

let events
try {
  events = readLogText(logPath)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
} catch (error) {
  fail(`could not read ${logPath}: ${error instanceof Error ? error.message : String(error)}`)
}
if (events.length === 0) fail(`${logPath} carried no events`)

const result = analyse(events)
const configured = readConfiguredRoutes(process.env.DSH_PROFILE_DIR ?? join(home, `profiles/${process.env.DSH_PROFILE ?? 'web'}`))
const outcome = report(result, configured, logPath)
if (asJson) console.log(JSON.stringify({ ...result, configured, active: outcome.active }, null, 2))
else console.log(outcome.text)
process.exit(outcome.active ? 0 : 1)
