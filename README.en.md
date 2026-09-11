**English** | [中文](README.md)

# @zhourenke/dsh-reasoning-summary

`@zhourenke/dsh-reasoning-summary` is a phase-one DeepSeek Harness Cordis plugin. It asks configured model routes for one concise action summary before a tool call, normalizes that summary, and writes it to durable session history so every later model can see the complete action trail.

The feature is intentionally opt-in. An empty `models` list injects no prompt, changes no current stream, and creates no new relay or continuation.

## Core contract

`models` is an exact `provider + model` route list. It controls only **new-summary behavior for a newly admitted step**; it does not select DSH's general model and does not partition session history.

Each step samples its route and settings once at admission:

| Step admission | New behavior for the current step | Existing summary history |
|---|---|---|
| Exact route enabled | Inject the instruction, process the stream, and possibly create a relay or reasoning-only continuation | Fully visible |
| Exact route disabled | Pass the ordinary stream through unchanged; create no new relay or continuation | Fully visible |

An admitted enabled step owns its stream state. A model switch or settings change during that stream does not cancel, clear, or rewrite the step; it still completes and persists its summary. The change applies to the next step. Relay and continuation messages declare only plugin identity and semantic form; they carry no source-route fields and are never used to hide history.

The resulting behavior is deliberate:

- A enabled → B disabled → A enabled: B reads A's existing summaries without creating any, and A resumes creating new summaries later.
- Disable A's setting → re-enable A: the disabled interval creates no summaries, old summaries remain visible, and later A steps resume generation.
- A → B → C → D, with A/C enabled and B/D disabled: all four models receive the complete existing summary history; only new tool steps on A/C create relays.
- Start with disabled B and an empty history: B creates nothing; switching later to enabled A starts the first summary from an empty history.

The plugin does not install a route-aware `Session.deriveMessages()` filter and does not append empty assistant replacements. Ordinary user/assistant, reasoning, tool, other-plugin context, relay, and continuation messages follow DSH's normal durable projection for every route.

## Scope

Implemented in this release:

- an English system-prompt instruction for exact enabled routes;
- exact `provider + model` matching;
- one concrete, actionable summary immediately before a tool call;
- complete, inferred, missing, and partial summary normalization;
- per-agent and per-step stream state through DSH's normal `llm/stream` waterfall, including prepared calls;
- removal of every tool-step text block from the assistant UI stream while preserving its usable execution detail in the relay; no-tool final answers remain visible;
- relay injection after all root tool results are durably committed;
- durable turn-ending relays appended as ordinary `user/message` events and visible to all later routes;
- a bounded same-turn continuation notice, at most three attempts, through public `agent.steer()` for reasoning-only responses; the notice is durable context and is not route-filtered or surface-masked;
- a settings card that reads the live model catalog and preserves stale selections;
- ordinary DSH GUI messages remain visible; no global DOM chat-row filter is installed.

Not implemented by design:

- suppressing `reasoning_content` or choosing a suppression model;
- tool gating or tool permission policy;
- deleting historical `thinking` content.

Those belong to later phases.

## Installation

Install the package through the target DSH profile manager:

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-reasoning-summary"
```

The package's `cordis.patch.yml` inserts the plugin into the bundle. Restart the existing DSH Web service using its original command after installation, profile changes, or a Host-side rebuild, then refresh the existing GUI URL. This plugin does not start a replacement server.

## Configuration

The settings namespace is `reasoning-summary`:

```yaml
models:
  - provider: cotton-codex
    model: gpt-5.6-luna
```

The provider and model must both match; selecting the same model under another provider does not enable that route. An empty list is the only disabled state. The schema retains only `models`, normalizing away unrelated fields left by an older plugin version. The settings card edits only this plugin's namespace and never changes DSH's general model selection. Enabled entries that are unavailable in the model catalog remain visible so they can recover or be removed deliberately.

## Stream protocol

When preparing to call tools, a model must emit one literal tag immediately before the first tool call:

```xml
<summary>target, concrete evidence or current state, and the immediate operation or decision</summary>
```

The summary is the execution record for the next step, not a generic status report. It should name the relevant user request, file/function/command, verified observation or result, and immediate next action or decision. It must not be reduced to unusable wording such as “continue analysis”, “check the implementation”, or “make progress”.

A tool-calling step must not emit ordinary assistant prose outside the tag. At the finish boundary the plugin also removes every text block from that tool step's UI stream, so a missed protocol cannot leak context-free internal progress; provider tool-block order is not changed. If the provider ends with `error`/`aborted` or the stream throws, a failed attempt that already emitted a tool call also hides its buffered text blocks but creates no relay, so failed progress is never mistaken for a completed execution record. Within one text block, it extracts the nearest complete `<summary>...</summary>` pair, so a stray opening tag cannot claim a later complete pair. The first valid pair is authoritative; the input tag only captures this step's record, and later models receive the compact relay:

```text
[Action summary]
Read src/index.ts; confirmed the parser location; next update the nearest-pair regression.
```

If a tool step has no complete tag but does contain ordinary execution prose, the plugin hides that prose and saves it as an `inferred` summary. This retains useful details without rendering a disconnected progress message, and later models see `[Action summary: inferred]`. If it has neither a complete tag nor usable text, the relay uses `[Action summary: missing]`; when a non-failed stream ends before a closing tag, its received content uses `[Action summary: partial]` and retains these notices:

```text
Summary unavailable: the model did not provide a complete summary.

Summary incomplete: the response ended before the closing tag.
```

A final natural-language answer does not require a summary and never creates a relay. A no-tool answer completely bypasses summary parsing, tag removal, and normalization; even literal `<summary>...</summary>` markup remains byte-for-byte in every text block.

In the installed DSH `0.1.5-rc.1`, `PreparedLlmCall.stream()` enters the same `llm/stream` waterfall, so ordinary summary normalization covers prepared-call paths. The plugin handles only the ordinary Agent Loop request with no `purpose` and confirms ownership with the current step's cancellation signal; auxiliary calls such as session-title and compaction may reuse the same `sessionId` but never enter summary state. The marker set behind `dsh-llm`'s own `isAgentLoopRequest()` is module-local, and a profile plugin can resolve a different physical copy, which is why this plugin does not depend on it. The durable `assistant/message` check is only a defensive reasoning-only fallback for callers that bypass this stream hook.

## Summary history and relays

Each tool-step summary is written or queued as an ordinary `user/message` with source metadata:

```json
{ "kind": "plugin", "plugin": "reasoning-summary", "form": "relay" }
```

The model-facing body uses a compact form. A complete summary retains only one semantic heading and the record itself:

```text
[Action summary]
Read src/index.ts; confirmed the parser location; next update the nearest-pair regression.
```

Only fallback or incomplete records label `inferred`, `partial`, or `missing` in the heading. Plugin identity, source form, provider/model, turn/step, and an XML wrapper no longer repeat in the body: DSH retains provenance in the durable message `source`, while the body holds only action facts needed by the next step. Existing relay text in older sessions remains ordinary history; this plugin does not rewrite it automatically.

For a continuing tool loop, the plugin waits for every root durable `tool/result`, queues the relay through the Agent inbox, and lets the following step consume and append it to durable session history. When the tool call ends the turn, the plugin also appends the relay directly with `surfaceOp: 'append'`. Both relay forms remain in normal session history, so every later provider/model can read them through `Session.deriveMessages()`; no source-route hiding, replacement, or second masking pass is used.

When a model emits non-empty reasoning without a tool call or user-facing answer, the plugin uses public `agent.steer()` to continue the same turn. Its model-facing notice begins `[Continue after reasoning-only response]` and no longer nests a normalized summary. Enablement belongs only to the step that creates the notice. A later disabled route can still read an existing notice, but does not create another continuation because of it.

Older plugin versions used replacements to hide turn-ending relays. For sessions that already contain those replacements, removing the new code cannot reverse DSH's append-only surface projection: the original relay may remain in the raw log while the current surface/derived history is shadowed by the old replacement. Restoring such sessions requires an explicit raw-log reconstruction or migration; this package does not rewrite user history automatically. Relays produced by the current implementation use no replacement.

## Development

This package targets DSH `0.1.5-rc.1` and Node.js 20 or newer. Host packages are declared as `peerDependencies`; the `devDependencies` exist only for local typechecking and tests and are pinned to the target host version:

```powershell
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

`pnpm test` currently passes 51 tests covering configuration normalization, exact route matching, complete cross-route history visibility, the A/B/C/D route sequence, settings disable/re-enable behavior, completion of an admitted step after a mid-stream switch, relay and continuation timing, same-session session-title and different-signal auxiliary-stream isolation, tool-result deduplication, compact complete/inferred/partial/missing relay headings, ordinary and failed tool-step text suppression, nearest-neighbor tag pairing, byte-preserved literal markup in no-tool final answers, provider block ordering, the prepared-call defensive fallback, the absence of a global client chat-row filter, and the client reading the host catalog only through the `remote.session` namespace.

## License

MIT
