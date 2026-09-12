**English** | [中文](README.md)

# @zhourenke/dsh-reasoning-summary

**So a model that cannot see its own thinking can still see its own mind.**

By default DSH keeps a model's thinking and passes it into the next loop, which is what gives thinking its continuity and makes earlier thinking visible — **it is only lost when context compaction kicks in**. For a model that can see its own thinking, that problem is already solved.

Closed models are the exception: their encrypted thinking never enters DSH's context in full, and DSH cannot continue from that provider's native state either. So on every next loop the model starts over, guessing what it just did, what comes next and where it is heading — and that work is thrown away again on the step after. It costs a lot of time and a lot of tokens.

This plugin fills the gap in the middle: on the routes you select, it asks the model to leave one short action summary as **visible text** before calling a tool, and writes that summary into session history. The next step — and every step after it — can then read what the previous one was doing, what it was based on, and what comes next. **It only affects the routes you select: other models are untouched and no history is hidden.**

## What it solves

- **The encrypted-thinking gap**: a closed provider's encrypted reasoning never enters DSH's context in full and cannot be continued from native provider state; this plugin turns "what the last step did" into ordinary history the model can read back.
- **Time and tokens no longer spent re-deriving**: the model does not have to guess its own previous step every time, which is what a long tool loop otherwise burns repeatedly.
- **Survives a model switch**: the summary travels as ordinary session history, so switching models mid-conversation still works.
- **Only the routes you choose**: exact `provider` + `model` matching; other models behave exactly as before.
- **History is never hidden**: summaries are appended as ordinary messages — no route filters, no masking.
- **Removable at any time**: inserted at the profile layer without touching DSH itself; clear the list to turn it off.

## Installation

```powershell
dsh plugin --profile web add "github:zhourenke/dsh-reasoning-summary"
```

**DSH needs a restart after installing** — the bundle set is a snapshot taken at process start, so the plugin is not loaded before a restart and refreshing the page does nothing. This is a dual-half plugin: after the restart, **refresh the page once** as well, so the settings card appears.

Uninstall:

```powershell
dsh plugin --profile web remove @zhourenke/dsh-reasoning-summary
```

## Quick start

The plugin is **off by default** (an empty `models` list): it injects no prompt, changes no stream, and produces no summaries.

The easiest way to turn it on is the interface: open **Settings → Plugins → Reasoning summary**, tick the routes you want, and save. The card reads DSH's live model catalog, so entries stay saved even while a model is temporarily unavailable.

You can also edit the configuration file `<harness home>/settings.yaml` directly (on Windows, `%USERPROFILE%\.dsh\settings.yaml`). It is organised by namespace, and this plugin's namespace is `reasoning-summary`:

```yaml
reasoning-summary:
  models:
    - provider: <provider-id>
      model: <model-id>
```

`provider` and `model` must be byte-identical to the real DSH ids, and both must match — a mistyped entry is not an error, it simply never fires (ticking entries in the settings card avoids typos entirely).

**Saving takes effect immediately; neither half needs a restart.** `settings.yaml` is hot-reloaded (file watching is on by default, and writes and reloads are serialised through one operation chain so a half-written file is never read), and a change applies to subsequent steps at once. Only **installing or uninstalling the plugin itself** needs a restart — the two are constantly confused, and the answers are opposite.

To confirm it is working, have a selected model make one tool call and look at two things: the model emits `<summary>…</summary>` as visible text, and the next step receives an `[Action summary]` record. If the model forgets, you will see `[Action summary: missing]` — that is the plugin reminding it.

## Configuration

| Field | Type | Default | Description |
|---|---|:---:|---|
| `models` | array | `[]` | The trigger routes, each `{ provider, model }`. **An empty list is the only disabled state**, and the default. |

Rules:

- `provider` and `model` must **both** match; the same model under another provider does not enable that route.
- A mistyped provider or model is not an error — that rule simply never fires. Both must be byte-identical to the real DSH provider id and model id (tick them in the settings card instead of typing them).
- The schema retains only `models`: unrelated fields left by an older version are normalized away on read and never break loading.
- The settings card edits only this plugin's namespace and never changes DSH's general model settings. Enabled entries that are currently unavailable stay in a trailing "saved but currently unavailable" group so you can uncheck them deliberately.

## What the plugin asks the model to do

Once enabled, the plugin adds an instruction to the system prompt of the selected routes: **before calling a tool, write one action summary as visible text**, in a literal tag:

```xml
<summary>target, concrete evidence or current state, and the immediate operation or decision</summary>
```

The summary is the **execution record for the next step**, not a status report: name the relevant user request, the file / function / command, the verified observation or result, and the immediate next action or decision. Wording that cannot be acted on — "continue analysis", "check the implementation", "make progress" — is of no use.

Only **visible text** counts: a summary that lives in reasoning/thinking content is invisible to the plugin and treated as missing. The summary also has to come before the first tool call.

If the model emits ordinary prose outside the tag, the plugin removes those text blocks from the UI stream when the step ends (provider tool-block order is unchanged), so the interface never shows a stretch of context-free internal progress. If the provider ends with `error` / `aborted`, or the stream itself throws, a failed attempt that already emitted a tool call hides its buffered text the same way but produces **no** record — failed progress is never mistaken for a completed execution record.

When the model misses it, the next step carries this reminder:

```text
Missing action summary: no <summary> tag was received in visible text — reasoning/thinking content is never read, and text outside the tag is discarded. Before your next tool call, emit the summary as visible assistant text in a literal <summary>...</summary> tag.
```

When a non-failed stream ends before the closing tag, what arrived is treated as incomplete:

```text
Summary incomplete: the response ended before the closing tag; only a fully closed tag counts as a summary.
```

A final ordinary answer **requires no summary** and produces no record; a no-tool answer skips summary parsing and tag removal entirely, so even literal `<summary>…</summary>` markup is preserved as it is.

## Where the summary goes

Each tool-step summary is written or queued as an ordinary `user/message`; the model sees the compact form:

```text
[Action summary]
Read src/index.ts; confirmed the parser location; next update the nearest-pair regression.
```

Only incomplete or missing records label `partial` or `missing` in the heading. While the tool loop continues, the plugin waits until every root tool call's durable `tool/result` is committed before queueing the summary into the Agent inbox; when the tool call ends the turn, the summary is appended to the durable session directly. Both forms stay in normal session history and are readable by every later provider / model — this plugin neither hides nor rewrites existing history.

When a model emits reasoning only, with neither a tool call nor a visible answer, the plugin uses public `agent.steer()` to ask for a continuation inside the **same turn**. The notice is headed `[Continue after reasoning-only response]`, at most 3 times — so a model that keeps emitting reasoning alone cannot hold the turn open forever.

## When it applies

Each step samples its route and settings once, **at admission**:

| Step admission | New behavior for the current step | Existing summary history |
|---|---|---|
| Exact route enabled | Inject the instruction; process the stream; possibly produce a relay or reasoning-only continuation | Fully visible |
| Exact route disabled | Pass the ordinary stream through unchanged; produce no new relay / continuation | Fully visible |

An admitted enabled step owns its stream state: if a model switch or a settings change happens while that stream is running, the step is **not** cancelled, cleared or rewritten — it still finishes and persists its summary, and the change applies to the next step. The following behaviors are therefore deliberate:

- A enabled → B disabled → A enabled: B reads A's existing summaries without creating any, and A resumes creating them.
- Turn the setting off and on again: the disabled interval creates no summaries, old ones remain visible, and generation resumes from the next step.
- A → B → C → D with A/C enabled and B/D disabled: all four models read the complete existing summary history; only new tool steps on A/C produce records.
- Starting on disabled B with empty history: B creates nothing; switching later to enabled A starts the first summary from an empty history.

## Notes for agents

- This plugin provides no tools, but it does **change what a selected route should emit**: a visible `<summary>…</summary>` before calling a tool. Text that only lives in reasoning / thinking does not count.
- It does not change the visible scope of session history: summaries are appended as ordinary messages, so every model sees the same history.
- A summary should be concrete about files / commands / observations and the next action; vague wording does not help the next step.
- Seeing `[Action summary: missing]` or `[Action summary: partial]` means the previous summary was incomplete; seeing `[Continue after reasoning-only response]` means the last response was reasoning only, with neither an action nor an answer.
- To tell whether the plugin is active: **Settings → Plugins** shows a "Reasoning summary" card, and `[Action summary]` records appear after tool steps.

## What it does not do

- **It does not suppress reasoning content**: `reasoning_content` / thinking flows through as usual; the plugin neither picks a suppression model nor deletes `thinking` from history.
- **No tool gating or permission policy**: which tools may run, and how often, is not decided here.
- **No session-history partitioning**: `models` only decides whether a new step produces a summary; it never changes what any model can see.
- **No rewriting of summaries already in history**: summaries in older sessions keep travelling as they are.

## Known limitations (measured)

- **Summaries are looked for in visible text only**: a summary written in reasoning / thinking counts as missing. That is deliberate — the model's thinking is never mistaken for an action record.
- **One step honours only the first complete tag**: the nearest complete pair inside one text block wins, and a stray opening tag cannot claim a later pair; but if a step writes several summaries, only the first counts.
- **Continuations are bounded**: a reasoning-only continuation is requested at most 3 times in one turn; after that the turn ends rather than continuing forever.
- **Shadowing by older versions is irreversible**: early versions used replacements to hide turn-ending summaries, and that shadowing does not undo itself when you upgrade — affected sessions need an explicit raw-log reconstruction or migration. The current implementation uses no replacement.
- **Install and uninstall need a restart**: the bundle set is fixed at process start. Configuration changes do not.

## Compatibility

Tested against **DSH v0.1.5-rc.1** (2026-09). This is a dual-half plugin: host-side changes need a DSH restart and browser-side changes additionally need a page refresh — both apply to plugin development only, not to everyday configuration changes.

## License

MIT
