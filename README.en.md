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
- complete, partial, and missing summary normalization;
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

When preparing to call tools, a model must emit the summary as **visible assistant text** — the text channel — never only in reasoning/thinking content; a summary present solely in reasoning is treated as missing. The tag must be literal text and appear immediately before the first tool call:

```xml
<summary>target, concrete evidence or current state, and the immediate operation or decision</summary>
```

The summary is the execution record for the next step, not a generic status report. It should name the relevant user request, file/function/command, verified observation or result, and immediate next action or decision. It must not be reduced to unusable wording such as “continue analysis”, “check the implementation”, or “make progress”.

A tool-calling step must not emit ordinary assistant prose outside the tag. At the finish boundary the plugin also removes every text block from that tool step's UI stream, so a missed protocol cannot leak context-free internal progress; provider tool-block order is not changed. If the provider ends with `error`/`aborted` or the stream throws, a failed attempt that already emitted a tool call also hides its buffered text blocks but creates no relay, so failed progress is never mistaken for a completed execution record. Within one text block, it extracts the nearest complete `<summary>...</summary>` pair, so a stray opening tag cannot claim a later complete pair. The first valid pair is authoritative; the input tag only captures this step's record, and later models receive the compact relay:

```text
[Action summary]
Read src/index.ts; confirmed the parser location; next update the nearest-pair regression.
```

If a tool step has no complete tag but does contain ordinary execution prose, the plugin hides that prose and never promotes it to a summary: any step without a usable `<summary>` tag relays `[Action summary: missing]` with the reminder to re-emit the tag as visible text. This suppresses disconnected progress messages without mistaking the model's own thinking prose for an action summary. reasoning/thinking content is never counted as usable text; when a non-failed stream ends before a closing tag, its received content uses `[Action summary: partial]` and retains these notices:

```text
Missing action summary: no <summary> tag was received in visible text — reasoning/thinking content is never read, and text outside the tag is discarded. Before your next tool call, emit the summary as visible assistant text in a literal <summary>...</summary> tag.

Summary incomplete: the response ended before the closing tag; only a fully closed tag counts as a summary.
```

A final natural-language answer does not require a summary and never creates a relay. A no-tool answer completely bypasses summary parsing, tag removal, and normalization; even literal `<summary>...</summary>` markup remains byte-for-byte in every text block.

The plugin handles only the main Agent Loop request: auxiliary calls such as session-title generation and compaction may reuse the same `sessionId` but neither enter summary state nor get rewritten by this plugin. In the installed DSH, prepared calls and ordinary calls enter the same `llm/stream` waterfall, so both paths are covered by the same normalization.

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

Only incomplete or missing records label `partial` or `missing` in the heading. DSH retains provenance in the durable message `source`, while the body holds only the action facts the next step needs. Existing relay text in older sessions remains ordinary history; this plugin does not rewrite it automatically.

For a continuing tool loop, the plugin waits for every root durable `tool/result`, queues the relay through the Agent inbox, and lets the following step consume and append it to durable session history. When the tool call ends the turn, the plugin also appends the relay directly to durable session history. Both relay forms remain in normal session history and are readable by every later provider/model; this plugin neither hides nor rewrites existing history.

When a model emits non-empty reasoning without a tool call or user-facing answer, the plugin uses public `agent.steer()` to continue the same turn. Its model-facing notice begins `[Continue after reasoning-only response]` and no longer nests a normalized summary. Enablement belongs only to the step that creates the notice. A later disabled route can still read an existing notice, but does not create another continuation because of it.

Older plugin versions used replacements to hide turn-ending relays, and that shadowing is **irreversible**: affected sessions do not recover by upgrading and need an explicit raw-log reconstruction or migration. The current implementation uses no replacement.

## Development

Internal implementation, build and test flow, and release discipline live in [DEVELOPMENT.md](DEVELOPMENT.md). Users do not need it.

## License

MIT
