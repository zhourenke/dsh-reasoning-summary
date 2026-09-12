**English** | [中文](README.md)

# @zhourenke/dsh-reasoning-summary

**So a model that cannot see its own thinking can still see its own mind.**

By default DSH keeps a model's thinking and passes it into the next loop; it is only lost when context compaction kicks in. **Closed models are the exception**: their encrypted thinking never enters DSH's context in full and cannot be continued from the provider's native state either, so on every next step the model re-derives what it just did — and that work is thrown away again on the step after, costing time and tokens for nothing.

This plugin has the selected routes leave one action summary as visible text before a tool call and writes it into session history, so the next step and every step after it can read it directly. It only affects the routes you select: other models are untouched and no history is hidden.

> ⚠️ **Weigh this before installing:** once enabled, the selected models switch from streaming output to **pseudo non-streaming** — the reply is buffered by the plugin and emitted in one go. Other models are unaffected.

## What it solves

- **Fills the encrypted-thinking gap**: a closed provider's encrypted reasoning never enters DSH's context; the plugin turns "what the last step did" into ordinary history the model can read.
- **Saves the cost of re-deriving**: the model no longer has to guess its own previous step every time.
- **Survives a model switch**: the summary travels as ordinary session history.
- **Only the routes you choose**: exact `provider` + `model` matching.
- **Removable at any time**: inserted at the profile layer without touching DSH itself; clearing the list turns it off completely.

## Installation

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-reasoning-summary"
```

DSH must be restarted and the page refreshed afterwards; the plugin's options then appear under **Settings → Plugins → Reasoning summary**.

Uninstall:

```powershell
dsh plugin --profile web remove @zhourenke/dsh-reasoning-summary
```

## Quick start

The plugin is **off by default** (an empty `models` list).

Open **Settings → Plugins → Reasoning summary**, tick the routes you want and save; the card reads DSH's live model catalog.

Or edit `~/.dsh/settings.yaml` directly:

```yaml
reasoning-summary:
  models:
    - provider: <provider-id>
      model: <model-id>
```

`provider` and `model` must be byte-identical to the real DSH ids and both must match; a mistyped entry is not an error, it simply never fires (ticking entries in the card avoids typos).

**Saving takes effect immediately — no restart, no page refresh.**

To confirm it is working: after the last tool call of each step, the interface shows an **Injected context · reasoning-summary** notice.

## Configuration

| Field | Type | Default | Description |
|---|---|:---:|---|
| `models` | array | `[]` | The trigger routes, each `{ provider, model }`. **An empty list is the only disabled state**, and the default. |

- `provider` and `model` must **both** match; the same model under another provider does not enable that route.
- Unrelated fields left by an older version are normalized away on read and never break loading.
- The settings card edits only this plugin's namespace and never changes DSH's general model settings. Enabled entries that are currently unavailable stay in a "saved but currently unavailable" group until you uncheck them.

## What the plugin asks the model to do

The plugin adds an instruction to the system prompt of the selected routes: **before calling a tool, write one action summary as visible text**, in a literal tag:

```xml
<summary>target, concrete evidence or current state, and the immediate operation or decision</summary>
```

The summary should name the relevant user request, the file / function / command, the verified observation or result, and the immediate next action or decision; wording that cannot be acted on — "continue analysis", "check the implementation" — is of no use.

Only **visible text** counts: a summary that lives in reasoning / thinking is treated as missing. It also has to come before the first tool call. None of this text — **including the summary tag itself** — is shown in the interface.

When the model misses it, the next step carries this reminder:

```text
Missing action summary: no <summary> tag was received in visible text — reasoning/thinking content is never read, and text outside the tag is discarded. Before your next tool call, emit the summary as visible assistant text in a literal <summary>...</summary> tag.
```

When a non-failed stream ends before the closing tag, what arrived is treated as incomplete:

```text
Summary incomplete: the response ended before the closing tag; only a fully closed tag counts as a summary.
```

A final ordinary answer requires no summary and produces no record; literal `<summary>…</summary>` markup in it is preserved as it is.

## Where the summary goes

Each tool-step summary is written or queued as an ordinary `user/message`; the model sees the compact form:

```text
[Action summary]
Read src/index.ts; confirmed the parser location; next update the nearest-pair regression.
```

Only incomplete or missing records label `partial` or `missing` in the heading. While the tool loop continues, the summary enters the Agent inbox after every root tool call's `tool/result` is committed; when the tool call ends the turn, it is appended to the durable session directly. Both forms stay in normal session history and are readable by every later provider / model.

When a model emits reasoning only, with neither a tool call nor a visible answer, the plugin asks for a continuation inside the **same turn**, headed `[Continue after reasoning-only response]`, at most 3 times.

## When it applies

Each step samples its route and settings once, **at admission**:

| Step admission | New behavior for the current step | Existing summary history |
|---|---|---|
| Exact route enabled | Inject the instruction; process the stream; possibly produce a relay or continuation | Fully visible |
| Exact route disabled | Pass the ordinary stream through unchanged; produce no new relay / continuation | Fully visible |

An admitted step is unaffected by later changes: a model switch or settings change applies to the next step, while the current one still finishes and persists its summary. These behaviors are therefore deliberate:

- A enabled → B disabled → A enabled: B reads A's existing summaries without creating any, and A resumes creating them.
- Turn the setting off and on again: the disabled interval creates no summaries, and old ones remain visible.
- A → B → C → D with A/C enabled and B/D disabled: all four models read the complete summary history; only new tool steps on A/C produce records.
- Starting on disabled B with empty history: B creates nothing; switching to enabled A starts the first summary from an empty history.

## Notes for agents

- This plugin provides no tools, but it **changes what a selected route should emit**: a visible `<summary>…</summary>` before calling a tool. Text that only lives in reasoning / thinking does not count.
- It does not change the visible scope of session history; every model sees the same history.
- A summary is concrete about the files / commands / observations and the next action.
- `[Action summary: missing]` / `[Action summary: partial]` means the previous summary was incomplete; `[Continue after reasoning-only response]` means the last response was reasoning only, with neither an action nor an answer.
- To tell whether the plugin is active: an **Injected context · reasoning-summary** notice appears in the interface after a tool step.

## What it does not do

- **It does not suppress reasoning content**: `reasoning_content` / thinking flows through as usual, and `thinking` is not deleted from history.
- **No tool gating or permission policy**: which tools may run, and how often, is not decided here.
- **No session-history partitioning**: `models` only decides whether a new step produces a summary.
- **No rewriting of summaries already in history**: summaries in older sessions keep travelling as they are.

## Known limitations (measured)

- **Summaries are looked for in visible text only**: one written in reasoning / thinking is treated as missing.
- **One step honours only the first complete tag**: the nearest complete pair inside one text block wins; if a step writes several summaries, only the first counts.
- **Continuations are bounded**: at most 3 times in one turn.
- **Shadowing by older versions is irreversible**: early versions used replacements to hide turn-ending summaries, and upgrading does not undo that — affected sessions need an explicit raw-log reconstruction or migration.

## Compatibility

Tested against **DSH v0.1.5-rc.1** (2026-09).

## License

MIT
