**English** | [中文](README.md)

# @zhourenke/dsh-reasoning-summary

**Have the selected models state what they are about to do — and why — before every tool call: the summary is written into conversation history, so any model that takes over can still read it.**

DSH models often fire several tool calls in a row inside one tool loop, while the "why, what I saw, what's next" lives only in that step's context — switch models, or look back a few turns later, and the reasoning is gone. This plugin asks the selected routes for one action summary **before** the tool call, normalizes it, and writes it into durable session history, so every later provider / model reads the complete action trail. **It only changes new steps on the selected routes: other models are untouched and existing history is never hidden.** Install it and it works, with no changes to DSH itself.

## What it solves

- **Switching models no longer loses context**: the summary travels as ordinary session history, so a mid-conversation model switch can pick up what was going on.
- **A tool loop leaves a readable trail**: one `[Action summary]` per tool step, instead of a bare run of tool calls and results.
- **Only the routes you choose**: exact `provider` + `model` matching; models you did not select behave exactly as before.
- **History is never hidden**: summaries are appended as ordinary messages — no route filters, no masking — so every model sees the same durable history.
- **Removable at any time**: inserted at the profile layer without touching DSH itself; clear the list in settings to turn it off.

## Installation

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-reasoning-summary"
```

**DSH must be restarted after installing** — the bundle set is a snapshot taken at process start, so the plugin is not loaded before a restart and refreshing the page does nothing. This is a dual-half plugin: after the restart, **refresh the page** as well, so the settings card appears.

Uninstall:

```powershell
dsh plugin --profile web remove @zhourenke/dsh-reasoning-summary
```

## Quick start

The plugin is **off by default** (an empty `models` list): it injects no prompt, changes no stream, and produces no summaries. To enable it, open **Settings → Plugins → Reasoning summary**, tick the routes you want, and save.

The equivalent direct form is editing `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: reasoning-summary
  name: '@zhourenke/dsh-reasoning-summary'
  config:
    models:
      - provider: cotton-codex
        model: gpt-5.6-luna
```

`id` must be `reasoning-summary`: the bundle already inserted that entry, so what you write is a **configuration override for the same id**. Do **not** wrap it in `- insert:` again — `insert` unconditionally appends a line, so writing it here adds a **second instance** and the summary logic runs twice.

**Configuration changes take effect on save, with no restart.** (The settings card applies to **later steps** immediately; a step already underway finishes with the configuration it was admitted under.) Only **installing or uninstalling the plugin itself** needs a restart — the two are constantly confused, and the answers are opposite.

To confirm it is really working, have a selected model make one tool call and look for two things: the model must emit `<summary>…</summary>` as visible text, and the next step receives an `[Action summary]` record. If the model forgets, you will see `[Action summary: missing]` — that is the plugin reminding it.

## Configuration

| Field | Type | Default | Description |
|---|---|:---:|---|
| `models` | array | `[]` | The trigger routes, each `{ provider, model }`. **An empty list is the only disabled state**, and the default. |

Rules:

- `provider` and `model` must **both** match; the same model under another provider does not enable that route.
- A mistyped provider or model is not an error — that rule simply never fires. Both must be byte-identical to the real DSH provider id and model id (tick them in the settings card instead of typing them).
- The schema retains only `models`: unrelated fields left by an older version are normalized away on read and never break loading.
- The settings card edits only this plugin's namespace and never changes DSH's general model settings. Enabled entries that are currently unavailable in the catalog **stay visible** in a trailing "saved but currently unavailable" group so you can uncheck them deliberately.

## What the model must emit

When preparing to call a tool, a selected model must emit the summary as **visible assistant text** — the text channel — never only in reasoning/thinking content; a summary that appears solely in reasoning counts as missing. The tag must be literal text and come before the first tool call:

```xml
<summary>target, concrete evidence or current state, and the immediate operation or decision</summary>
```

The summary is the **execution record for the next step**, not a generic status report: name the relevant user request, the file / function / command, the verified observation or result, and the immediate next action or decision. Do not reduce it to unusable wording such as "continue analysis", "check the implementation", or "make progress".

A tool-calling step should not emit ordinary prose outside the tag. If the protocol is missed, the plugin removes every text block of that step from the UI stream at the finish boundary (provider tool-block order is unchanged), so the interface never leaks context-free internal progress. If the provider ends with `error` / `aborted` or the stream throws, a failed attempt that already emitted a tool call also hides its buffered text but creates **no** relay — failed progress is never mistaken for a completed execution record.

When a step has no complete tag, the plugin never guesses that ordinary prose was meant as a summary:

```text
Missing action summary: no <summary> tag was received in visible text — reasoning/thinking content is never read, and text outside the tag is discarded. Before your next tool call, emit the summary as visible assistant text in a literal <summary>...</summary> tag.
```

When a non-failed stream ends before the closing tag, what arrived is treated as incomplete:

```text
Summary incomplete: the response ended before the closing tag; only a fully closed tag counts as a summary.
```

A final ordinary answer **requires no summary** and never creates a relay; a no-tool answer bypasses summary parsing and tag removal entirely, so even literal `<summary>…</summary>` markup is preserved byte for byte.

## What a summary looks like, and where it goes

Each tool-step summary is written or queued as an ordinary `user/message`; the model sees the compact form:

```text
[Action summary]
Read src/index.ts; confirmed the parser location; next update the nearest-pair regression.
```

Only incomplete or missing records label `partial` or `missing` in the heading. While the tool loop continues, the plugin waits until every root tool call's durable `tool/result` is committed before queueing the relay into the Agent inbox; when the tool call ends the turn, the relay is appended to the durable session directly. Both forms stay in normal session history and are readable by every later provider / model — this plugin neither hides nor rewrites existing history.

When a model emits reasoning only, with neither a tool call nor a visible answer, the plugin uses public `agent.steer()` to ask for a continuation inside the **same turn**. The notice is headed `[Continue after reasoning-only response]`, at most 3 times — so a model that keeps emitting reasoning alone cannot hold the turn open forever.

## Step admission: when it applies

Each step samples its route and settings once, **at admission**:

| Step admission | New behavior for the current step | Existing summary history |
|---|---|---|
| Exact route enabled | Inject the instruction; process the stream; possibly create a relay or reasoning-only continuation | Fully visible |
| Exact route disabled | Pass the ordinary stream through unchanged; create no new relay / continuation | Fully visible |

An admitted enabled step owns its stream state: a model switch or settings change during that stream does **not** cancel, clear, or rewrite the step — it still finishes and persists its summary, and the change applies to the next step. The following behaviors are therefore deliberate:

- A enabled → B disabled → A enabled: B reads A's existing summaries without creating any, and A resumes creating them.
- Turn the setting off and on again: the disabled interval creates no summaries, old ones remain visible, and generation resumes from the next step.
- A → B → C → D with A/C enabled and B/D disabled: all four models read the complete existing summary history; only new tool steps on A/C create relays.
- Starting on disabled B with empty history: B creates nothing; switching later to enabled A starts the first summary from an empty history.

## Notes for agents

- This plugin **provides no tools**, but it **changes what you must emit**: a selected route must output a literal `<summary>…</summary>` before calling a tool. Writing it in reasoning / thinking does not count.
- The summary is an execution record for the next step: be concrete about files / commands / observations and the next action. Skip empty phrases like "continue analysis".
- Do not emit ordinary prose outside the tag on a tool step; anything extra is hidden from the interface, so it is wasted.
- Seeing `[Action summary: missing]` or `[Action summary: partial]` means the previous one was incomplete: emit the full literal tag before your next tool call.
- Seeing `[Continue after reasoning-only response]` means the last response was reasoning only: either call a suitable tool or give the complete answer.
- To tell whether the plugin is active: **Settings → Plugins** shows a "Reasoning summary" card, and the selected routes produce the records above.

## What it does not do

- **It does not suppress reasoning content**: `reasoning_content` / thinking flows through as usual; the plugin neither picks a suppression model nor deletes `thinking` from history.
- **No tool gating or permission policy**: which tools may run, and how often, is not decided here.
- **No session-history partitioning**: `models` only decides whether a new step produces a summary; it never changes what any model can see.
- **No rewriting of old relays in history**: summaries already in a session keep travelling as they are.

## Known limitations (measured)

- **Summaries are looked for in the text channel only**: a summary written in reasoning / thinking counts as missing. That is deliberate — the model's own thinking is never mistaken for an action record.
- **One step honours only the first complete tag**: the nearest complete pair inside one text block wins, and a stray opening tag cannot claim a later pair; but if a step writes several summaries, only the first counts.
- **Continuations are bounded**: a reasoning-only continuation is requested at most 3 times in one turn; after that the turn ends rather than continuing forever.
- **Shadowing by older versions is irreversible**: early versions used replacements to hide turn-ending relays, and that shadowing does not undo itself when you upgrade — affected sessions need an explicit raw-log reconstruction or migration. The current implementation uses no replacement.
- **Install and uninstall need a restart**: the bundle set is fixed at process start, so `dsh plugin add/remove` must be followed by a restart. Configuration changes do not.

## Compatibility

Tested against **DSH v0.1.5-rc.1** (2026-09). This is a dual-half plugin: host-side changes need a DSH restart, and browser-side changes additionally need a page refresh.

## License

MIT
