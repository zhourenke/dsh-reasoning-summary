import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// The host contracts this file models, as measured from the installed
// 0.2.0-rc.2 packages. Keep the citations when editing: a mock that drifts from
// the real contract hides defects instead of catching them (a "false green" —
// see PLUGIN_RELEASE_GUIDE.md -> guide/verification-method.md "验证本身也会骗你").
//
// 1. The card seat `plugins.row.config` is declared by the plugins surface, at
//      @deepseek-ai/dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts
//        'plugins.row.config': { kind: 'keyed'; scope: 'root';
//                                owner: PluginConfigViewProps }
//    and is dispatched by `<package name>#<row id>`. The owner props are
//    `{ view: 'summary' | 'page'; form?: ConfigPageForm }`, and the same entry is
//    rendered twice, so both views mount as separate entries — a hook that only
//    runs in one view would change the hook order when a row is opened.
//
// 2. Registration shape, taken from the sibling card shipped against the same
//    surface (dsh-reasoning-mode/src/client.ts):
//      ctx.effect(() => configForms.whileServed([NS], () => slots.inject(
//        'plugins.row.config',
//        () => slots.register({ name: 'plugins.row.config',
//                              key: `${PACKAGE_NAME}#${NS}`, locale: NS }, Card),
//      )))
//    The page exists only while the Host serves the namespace, so `whileServed`
//    is what keeps a registration from outliving its entry.
//
// 3. `locale: NS` on the registration is what puts the translator on the props:
//    the renderer reads the entry's `locale` and composes `kit.t =
//    localeSeat(face, ns)`, throwing when no locale face is installed. Binding our
//    own translator would shadow that identical prop. This file's fake `locale`
//    service therefore has NO `bind` at all — a reintroduced `locale.bind(NS)`
//    throws here instead of silently shadowing the seat's translator.
//
// 4. `ConfigPageForm.mutate(ops, expectedRevision?)` performs the write and
//    resolves whether the Host accepted it; a stale revision is refused rather
//    than overwriting a concurrent write
//    (dsh-client-ui-settings/lib/types/client/config-form-types.d.ts).
//
// 5. The page body now draws its own frame. DSH 0.2.2 removed the shared
//    `SettingsForm` primitive (`@deepseek-ai/dsh-client-ui-primitives` is no
//    longer a package of the host tree at all), and `plugins.row.config` owners
//    render the form together with its save control
//    (dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts: the
//    `page` view "renders the form with its save control"). The card therefore
//    owns `div.rs-form` with `div.rs-actions`, and `require` reaches only `react`.
//
// NOT modelled here: React's reconciler and hook semantics (the stub keeps
// per-slot state and replays only the passes a test drives — no scheduling, no
// batching, no dependency arrays), the host's real slot registry, and the
// plugins page that dispatches the slot. This file proves the plugin's side of
// the contract; the Host's side is proven by the card appearing in a running
// deployment.
// ---------------------------------------------------------------------------

// The browser half is a plain script: it registers itself through
// `window.__ModuleLoader__.load(...)` at module scope, so the stub must exist
// before the module is evaluated. This is the only test that executes
// `lib/client.js`; the rest assert on its source and on the Host half.
const definitions = []
globalThis.window = { __ModuleLoader__: { load: (definition) => definitions.push(definition) } }
await import('../lib/client.js')

const definition = definitions[0]
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const PACKAGE_NAME = '@zhourenke/dsh-reasoning-summary'
const NS = 'reasoning-summary'

/**
 * Build a factory `require` that satisfies the one module the card imports.
 * `elements` records every `createElement` call, which is how a test observes
 * what the card would render.
 */
function makeRequire() {
  const requested = []
  const elements = []
  // Hook state is kept per `useState` call order, so a test can observe a state
  // change by rendering the component again. Only `useState` consumes the slot
  // cursor: `useMemo` and `useEffect` are stateless here. Effects still run
  // inline, and every pass re-runs them, so a test that renders twice sees the
  // effect fire twice — assert on the settled render, not on the call count.
  const hooks = { slots: [], cursor: 0 }
  const require = (id) => {
    requested.push(id)
    if (id === 'react') {
      return {
        createElement: (component, props, ...children) => {
          const element = { component, props, children }
          elements.push(element)
          return element
        },
        // The stub runs effects immediately and models no reconciler: it
        // observes what the passes a test drives actually render.
        useEffect: (callback) => { callback() },
        useMemo: (callback) => callback(),
        // React invokes a function initial state lazily; the card relies on it
        // to copy the saved selection out of the form.
        useState: (initial) => {
          const slot = hooks.cursor
          hooks.cursor += 1
          if (hooks.slots.length <= slot) hooks.slots.push(typeof initial === 'function' ? initial() : initial)
          return [hooks.slots[slot], (next) => {
            hooks.slots[slot] = typeof next === 'function' ? next(hooks.slots[slot]) : next
          }]
        },
      }
    }
    throw new Error(`unexpected require("${id}")`)
  }
  return { require, requested, elements, hooks }
}

/**
 * The page body's own frame, as the card draws it. `dirty`, `saving`, `failed`
 * and `readOnly` are read back off the rendered controls rather than off
 * internal state, so a test proves what the person sees.
 */
function frameOf(elements) {
  const frame = findElement(elements, (el) => el.component === 'div' && el.props?.className === 'rs-form')
  if (!frame) return undefined
  const actions = frame.children.find((child) => child?.props?.className === 'rs-actions')
  const buttons = actions.children.filter((child) => child?.component === 'button')
  const discard = buttons.find((button) => button.props.className === 'rs-secondary')
  const save = buttons.find((button) => button.props.className === 'rs-primary')
  return {
    frame,
    actions,
    discard,
    save,
    field: frame.children.find((child) => child?.props?.className === 'rs-field'),
    dirty: save !== undefined && save.props.disabled === false,
    failed: actions.children.some((child) => child?.props?.className === 'rs-failure'),
    readOnly: actions.children.some((child) => child?.props?.className === 'rs-readonly'),
  }
}

/** The official translator's own substitution rule, used to compose `kit.t`. */
function interpolate(template, params) {
  return String(template).replace(/\{(\w+)\}/g, (match, name) => (
    params && name in params ? String(params[name]) : match
  ))
}

/**
 * Minimal stand-in for the client services the browser half touches, shaped
 * after the measured contracts above. `options.form` overrides the Host form the
 * page receives; `options.models` seeds the value behind it.
 */
function makeCtx(options = {}) {
  const state = {
    injected: [],
    registered: [],
    locales: [],
    effects: 0,
    whileServed: [],
    modelCatalogCalls: 0,
    styleAppends: 0,
  }
  const value = { models: options.models ?? [] }
  const form = options.form ?? {
    state: { status: 'ready', value, writable: true, revision: 7 },
    mutate: async () => true,
  }
  const ctx = {
    slots: {
      inject(name, callback) {
        state.injected.push(name)
        callback()
      },
      register(slotDefinition, render) {
        state.registered.push({ slotDefinition, render })
        return () => {}
      },
    },
    configForms: {
      get: () => undefined,
      whileServed(namespaces, callback) {
        state.whileServed.push(namespaces)
        callback()
        return () => {}
      },
    },
    // Deliberately no `bind`: the seat supplies the translator (contract fact 3).
    locale: {
      register(namespace, dictionaries) {
        state.locales.push({ namespace, dictionaries })
        return () => {}
      },
    },
    effect(callback) {
      state.effects += 1
      callback()
      return () => {}
    },
  }
  // `options.withoutGet` models a container that only exposes the namespace as
  // a plain property, which is the last-resort resolution path.
  if (!options.withoutGet) {
    ctx.get = (name) => {
      if (name === 'remote.session') return options.viaNamespace
      if (name === 'remote') return options.viaRemoteParent
      return undefined
    }
  }
  if (options.propertyParent !== undefined) ctx.remote = { session: options.propertyParent }
  if (options.withCatalog) {
    const face = {
      modelCatalog: async () => {
        state.modelCatalogCalls += 1
        return { ok: true, value: { groups: options.groups ?? [] } }
      },
    }
    if (options.withoutGet) ctx.remote = { session: face }
    else {
      const base = ctx.get
      ctx.get = (name) => (name === 'remote.session' ? face : base(name))
    }
  }
  return { ctx, state, form }
}

/** Compose the translator the renderer builds from the entry's `locale`. */
function kitFor(state, namespace) {
  const entry = state.locales.find((item) => item.namespace === namespace)
  const dictionaries = entry?.dictionaries ?? {}
  return (key, params) => interpolate(dictionaries.en?.[key] ?? key, params)
}

/** Render the registered page once, the way the renderer mounts one view. */
function render(state, props) {
  const { render: mount } = state.registered[0]
  const element = mount(props)
  return { element, card: element.component(element.props) }
}

/** One render pass: hook slots restart, and only this pass's elements remain. */
function renderPass(state, props, handle) {
  const { render: mount } = state.registered[0]
  const element = mount(props)
  handle.hooks.cursor = 0
  handle.elements.length = 0
  return { element, card: element.component(element.props) }
}

/**
 * Render through the passes the card's own state updates require, the way the
 * renderer replays them after a `setState`. A single pass cannot observe what a
 * later one draws: the model catalog arrives from the Host, and a save moves
 * `dirty` and `failed`. `handle.elements` holds the settled pass afterwards.
 */
async function renderSettled(state, props, handle, passes = 2) {
  let settled
  for (let pass = 0; pass < passes; pass += 1) {
    if (pass > 0) await new Promise((resolve) => setImmediate(resolve))
    settled = renderPass(state, props, handle)
  }
  return settled
}

function findElement(elements, predicate) {
  return elements.find(predicate)
}

test('the browser half registers itself with the host ModuleLoader', () => {
  assert.equal(definitions.length, 1)
  assert.equal(definition.id, PACKAGE_NAME)
  assert.equal(typeof definition.factory, 'function')
})

test('the factory returns the plugin contract and requests only host modules', () => {
  const { require, requested } = makeRequire()
  const plugin = definition.factory(require)
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'configForms', 'locale', 'remote', 'remote.session'])
  // Only react: the shared settings primitive is gone from the host tree, so
  // nothing else may be requested.
  assert.deepEqual(requested.sort(), ['react'])
})

test('apply claims the plugin row seat while the Host serves the namespace', () => {
  const { require } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx()
  plugin.apply(ctx)

  // The registration is scoped to the served namespace, so it cannot outlive
  // its entry (contract fact 2).
  assert.deepEqual(state.whileServed, [[NS]])
  assert.deepEqual(state.injected, ['plugins.row.config'])
  assert.equal(state.registered.length, 1)

  const { slotDefinition, render: mount } = state.registered[0]
  assert.equal(slotDefinition.name, 'plugins.row.config')
  // The key is `<package name>#<row id>`: the row id must match the
  // `- id:` line of cordis.patch.yml, or the plugins page never dispatches it.
  assert.equal(slotDefinition.key, `${PACKAGE_NAME}#reasoning-summary`)
  assert.equal(slotDefinition.locale, NS)
  assert.equal(typeof mount, 'function')

  assert.equal(state.locales.length, 1)
  assert.equal(state.locales[0].namespace, NS)
  assert.ok(state.locales[0].dictionaries.zh)
  assert.ok(state.locales[0].dictionaries.en)
  assert.equal(state.effects, 2)
})

test('the page one-liner renders the description and never reaches the Host', () => {
  const { require, elements } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx({ withCatalog: true })
  plugin.apply(ctx)

  const t = kitFor(state, NS)
  const { card } = render(state, { view: 'summary', t })
  assert.ok(card, 'the one-liner must always render')
  assert.equal(card.component, 'span')
  assert.equal(card.children[0], t('description'))
  // The one-liner is drawn once per row in a list, so it must not ask the Host
  // for a model catalog.
  assert.equal(state.modelCatalogCalls, 0)
  // It must not build the settings form either.
  assert.equal(frameOf(elements), undefined)
})

test('the page body draws its own frame over the Host form value', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const { require, elements } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state, form } = makeCtx({ models: [route], withCatalog: true, groups: [
    { id: 'cotton-codex', name: 'Cotton Codex', models: [{ id: 'gpt-5.6-luna', name: 'Luna' }] },
  ] })
  plugin.apply(ctx)

  const t = kitFor(state, NS)
  const { card } = render(state, { view: 'page', form, t })
  assert.ok(card, 'a ready form must render the page')
  // The catalog read is fired by the page view.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.modelCatalogCalls, 1)

  assert.equal(card.component, 'div')
  const frame = frameOf(elements)
  assert.ok(frame, 'the page body must be the entry\'s own frame')
  assert.equal(frame.frame.props.className, 'rs-form')
  // The route field is wrapped by the frame, and the save control is part of
  // the body now that no shared primitive draws it.
  assert.ok(frame.field, 'the frame must wrap the route field')
  assert.equal(frame.discard.children[0], t('discard'))
  assert.equal(frame.save.children[0], t('save'))
  // A pristine page has nothing to commit, so both controls start disabled.
  assert.equal(frame.dirty, false)
  assert.equal(frame.save.props.disabled, true)
  assert.equal(frame.discard.props.disabled, true)
  assert.equal(frame.failed, false)
  assert.equal(frame.readOnly, false)

  // The saved route is listed, checked, and still visible. The stub does not
  // expand nested function components, so the row element is expanded here — the
  // same call React would make — which is what proves the row's own shape.
  const row = findElement(elements, (el) => el.component?.name === 'ModelRow')
  assert.ok(row, 'the saved route must be listed')
  assert.equal(row.props.checked, true)
  assert.equal(row.props.disabled, false)
  const rowElement = row.component(row.props)
  assert.equal(rowElement.component, 'label')
  const checkbox = rowElement.children.find((child) => child?.component === 'input')
  assert.equal(checkbox.props.type, 'checkbox')
  assert.equal(checkbox.props.checked, true)
})

test('a page entry mounted without the owner form renders nothing', () => {
  const { require, elements } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx()
  plugin.apply(ctx)

  const t = kitFor(state, NS)
  const { card } = render(state, { view: 'page', form: undefined, t })
  assert.equal(card, null)
  assert.equal(frameOf(elements), undefined)
})

test('a loading form renders nothing so the unavailable notice cannot flash', () => {
  // `loading` is the config form's initial status while the Host describe read
  // is in flight (dsh-client-ui-settings/lib/types/client/config-form-types.d.ts),
  // so rendering a notice here would flash "not available" on every row open.
  const form = { state: { status: 'loading', value: undefined, writable: false }, mutate: async () => true }
  const { require, elements } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx({ form, withCatalog: true })
  plugin.apply(ctx)

  const { card } = render(state, { view: 'page', form, t: kitFor(state, NS) })
  assert.equal(card, null)
  assert.equal(frameOf(elements), undefined)
  // The catalog read is gated on readiness too: a list that cannot be drawn must
  // not cost a Host round trip.
  assert.equal(state.modelCatalogCalls, 0)
})

test('an unavailable form draws the notice here, since no primitive owns it', () => {
  // `unavailable` is held while the Host serves no document for the namespace
  // (dsh-client-ui-settings/lib/types/client/config-form-types.d.ts). With the
  // shared primitive gone, this entry answers that state itself.
  const form = { state: { status: 'unavailable', value: undefined, writable: false }, mutate: async () => true }
  const { require, elements } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx({ form, withCatalog: true })
  plugin.apply(ctx)

  const t = kitFor(state, NS)
  const { card } = render(state, { view: 'page', form, t })
  assert.equal(card.component, 'p')
  assert.equal(card.props.role, 'status')
  assert.equal(card.props.className, 'rs-notice')
  assert.equal(card.children[0], t('formUnavailable'))
  assert.equal(frameOf(elements), undefined)
  assert.equal(state.modelCatalogCalls, 0)
})

test('a saved route missing from the catalog stays listed as unavailable', async () => {
  const retired = { provider: 'retired-provider', model: 'retired-model' }
  const handle = makeRequire()
  const plugin = definition.factory(handle.require)
  const { ctx, state, form } = makeCtx({
    models: [retired],
    withCatalog: true,
    groups: [{ id: 'cotton-codex', name: 'Cotton Codex', models: [{ id: 'gpt-5.6-luna', name: 'Luna' }] }],
  })
  plugin.apply(ctx)

  const t = kitFor(state, NS)
  // Two passes: the first starts the catalog read, the second draws it.
  await renderSettled(state, { view: 'page', form, t }, handle)
  const { elements } = handle

  // One row per catalog model plus one for the saved route the catalog no longer
  // carries: a vanished selection is never silently dropped.
  const rows = elements.filter((el) => el.component?.name === 'ModelRow')
  assert.deepEqual(rows.map((row) => row.props.item.model).sort(), ['gpt-5.6-luna', 'retired-model'])
  const row = rows.find((candidate) => candidate.props.item.provider === 'retired-provider')
  assert.equal(row.props.available, false)
  assert.equal(row.props.checked, true)
  assert.equal(row.props.disabled, false, 'it must stay toggleable while the form is writable')

  // It collects in a trailing group under the saved-but-unavailable legend...
  const legend = findElement(elements, (el) => (
    el.props?.className === 'rs-provider' && el.children[0] === t('unavailableGroup')
  ))
  assert.ok(legend, 'the trailing group must be labelled as saved-but-unavailable')
  // ...and keeps the same checkbox row shape, carrying the unavailable label.
  const rowElement = row.component(row.props)
  assert.ok(rowElement.children.some((child) => child?.props?.className === 'rs-unavailable'))
  assert.ok(rowElement.children.some((child) => child?.component === 'input'))
})

test('save commits one revision-fenced write for the whole route list', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const writes = []
  const handle = makeRequire()
  const plugin = definition.factory(handle.require)
  const form = {
    state: { status: 'ready', value: { models: [route] }, writable: true, revision: 7 },
    mutate: async (ops, expectedRevision) => {
      writes.push({ ops, expectedRevision })
      return true
    },
  }
  const { ctx, state } = makeCtx({
    form,
    withCatalog: true,
    groups: [{ id: 'cotton-codex', name: 'Cotton Codex', models: [{ id: 'gpt-5.6-luna', name: 'Luna' }] }],
  })
  plugin.apply(ctx)

  const t = kitFor(state, NS)
  const props = { view: 'page', form, t }
  await renderSettled(state, props, handle)
  // Stage the removal of the only saved route, so Save commits an empty list.
  handle.elements.find((el) => el.component?.name === 'ModelRow').props.onToggle()
  renderPass(state, props, handle)
  await frameOf(handle.elements).save.props.onClick()

  assert.equal(writes.length, 1)
  // Staged locally and committed as one write, fenced by the revision the drafts
  // were staged against (contract fact 4).
  assert.deepEqual(writes[0].ops, [{ op: 'set', path: ['models'], value: [] }])
  assert.equal(writes[0].expectedRevision, 7)
})

test('a refused write is treated as a failure, not as a silent success', async () => {
  const writes = []
  const handle = makeRequire()
  const plugin = definition.factory(handle.require)
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const form = {
    state: { status: 'ready', value: { models: [route] }, writable: true, revision: 3 },
    mutate: async (ops, expectedRevision) => {
      writes.push({ ops, expectedRevision })
      return false
    },
  }
  const { ctx, state } = makeCtx({
    form,
    withCatalog: true,
    groups: [{ id: 'cotton-codex', name: 'Cotton Codex', models: [{ id: 'gpt-5.6-luna', name: 'Luna' }] }],
  })
  plugin.apply(ctx)

  const t = kitFor(state, NS)
  const props = { view: 'page', form, t }
  await renderSettled(state, props, handle)
  handle.elements.find((el) => el.component?.name === 'ModelRow').props.onToggle()
  renderPass(state, props, handle)
  await frameOf(handle.elements).save.props.onClick()
  renderPass(state, props, handle)

  assert.equal(writes.length, 1)
  assert.equal(writes[0].expectedRevision, 3)
  // A refused write must surface as a failure notice; a silent success would
  // leave the user thinking the list was saved. The draft stays dirty so a
  // retry is one click away.
  const settled = frameOf(handle.elements)
  assert.equal(settled.failed, true)
  assert.equal(settled.dirty, true)
  assert.equal(settled.save.children[0], t('save'))
  assert.equal(settled.actions.children.find((child) => child?.props?.className === 'rs-failure').children[0], t('saveFailed'))
})

test('a staged change marks the form dirty and an accepted save clears it', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const writes = []
  const handle = makeRequire()
  const plugin = definition.factory(handle.require)
  const form = {
    state: { status: 'ready', value: { models: [route] }, writable: true, revision: 11 },
    mutate: async (ops, expectedRevision) => {
      writes.push({ ops, expectedRevision })
      return true
    },
  }
  const { ctx, state } = makeCtx({
    form,
    withCatalog: true,
    groups: [{ id: 'cotton-codex', name: 'Cotton Codex', models: [{ id: 'gpt-5.6-luna', name: 'Luna' }] }],
  })
  plugin.apply(ctx)

  const t = kitFor(state, NS)
  const props = { view: 'page', form, t }
  const frame = () => frameOf(handle.elements)
  await renderSettled(state, props, handle)
  assert.equal(frame().dirty, false)

  // Unchecking the route stages a draft and marks the entry dirty; nothing
  // reaches the Host until the form's own Save is used.
  const row = handle.elements.find((el) => el.component?.name === 'ModelRow')
  row.props.onToggle()
  renderPass(state, props, handle)
  assert.equal(frame().dirty, true)
  assert.equal(writes.length, 0, 'staging a draft must not write')

  await frame().save.props.onClick()
  renderPass(state, props, handle)
  assert.equal(frame().dirty, false)
  assert.equal(frame().failed, false)
  assert.deepEqual(writes, [{ ops: [{ op: 'set', path: ['models'], value: [] }], expectedRevision: 11 }])
})

test('a read-only form still renders but can never write', async () => {
  const writes = []
  const { require, elements } = makeRequire()
  const plugin = definition.factory(require)
  const form = {
    state: { status: 'ready', value: { models: [] }, writable: false, revision: 5 },
    mutate: async (ops, expectedRevision) => {
      writes.push({ ops, expectedRevision })
      return true
    },
  }
  const { ctx, state } = makeCtx({ form })
  plugin.apply(ctx)

  const t = kitFor(state, NS)
  render(state, { view: 'page', form, t })
  const frame = frameOf(elements)
  assert.equal(frame.readOnly, true)
  assert.equal(frame.actions.children
    .find((child) => child?.props?.className === 'rs-readonly').children[0], t('readOnly'))
  assert.equal(frame.save.props.disabled, true)
  await frame.save.props.onClick()
  assert.equal(writes.length, 0, 'a read-only form must not attempt a write')
})

test('the catalog accessor resolves the remote session namespace service', () => {
  const face = { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) }
  const { require } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx({ viaNamespace: face })
  plugin.apply(ctx)

  const { element } = render(state, { view: 'summary', t: kitFor(state, NS) })
  assert.equal(element.props.sessionFace(), face)
})

test('the catalog accessor falls back to the remote parent service', () => {
  const face = { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) }
  const { require } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx({ viaRemoteParent: { session: face } })
  plugin.apply(ctx)

  const { element } = render(state, { view: 'summary', t: kitFor(state, NS) })
  assert.equal(element.props.sessionFace(), face)
})

test('the catalog accessor can read the namespace as a container property', () => {
  const face = { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) }
  const { require } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx({ withoutGet: true, propertyParent: face })
  plugin.apply(ctx)

  const { element } = render(state, { view: 'summary', t: kitFor(state, NS) })
  assert.equal(element.props.sessionFace(), face)
})

test('the catalog accessor stays undefined while the namespace is unmounted', () => {
  const { require } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx()
  plugin.apply(ctx)

  const { element } = render(state, { view: 'summary', t: kitFor(state, NS) })
  assert.equal(element.props.sessionFace(), undefined)
})

test('apply injects its stylesheet once and tolerates a document-less host', () => {
  const appendChild = () => {}
  const created = []
  globalThis.document = {
    querySelector: () => null,
    createElement: () => {
      const element = { dataset: {}, style: {}, textContent: '' }
      created.push(element)
      return element
    },
    head: { appendChild },
  }
  try {
    const { require } = makeRequire()
    const plugin = definition.factory(require)
    const { ctx } = makeCtx()
    plugin.apply(ctx)
    assert.equal(created.length, 1)
    assert.equal(created[0].dataset.pluginCss, 'reasoning-summary')
    assert.match(created[0].textContent, /\.rs-models/)

    // An existing stylesheet element must not be duplicated.
    globalThis.document.querySelector = () => ({})
    const second = makeCtx()
    plugin.apply(second.ctx)
    assert.equal(created.length, 1)
  } finally {
    delete globalThis.document
  }
})

test('apply stays inert when the required client services are absent', () => {
  const { require } = makeRequire()
  const plugin = definition.factory(require)
  const { state } = makeCtx()
  const bare = { effect: () => {}, get: () => undefined }
  plugin.apply(bare)
  assert.deepEqual(state.registered, [])
})

test('the entry draws no host-owned chrome and the deleted seats stay deleted', () => {
  // Gone with 0.2.0-rc.2: the catch-all seat, the scope binding, and the
  // hand-rolled card frame. Each of these would be a silent reimplementation of
  // what the official surfaces already do, so they are asserted absent.
  assert.doesNotMatch(source, /settings\.plugin\.item/)
  assert.doesNotMatch(source, /settingsScope/)
  assert.doesNotMatch(source, /locale\.bind/)
  assert.doesNotMatch(source, /rs-footer|rs-save|rs-discard|rs-chevron|rs-head\b|rs-pending|rs-failed/)
  // 0.2.2 removed the shared settings primitive altogether: requiring it would
  // fail in the browser, so the entry must not name it as a module, and it must
  // not render it (the file header still cites it as history).
  assert.doesNotMatch(source, /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/)
  assert.doesNotMatch(source, /e\(SettingsForm/)
  // What it draws instead is its own body plus the save control, inside the
  // page whose header and crumb stay the plugins page's.
  assert.match(source, /className: 'rs-form'/)
  assert.match(source, /className: 'rs-actions'/)
  // The removed icon must not be resurrected; 0.2.0-rc.2 renamed it.
  assert.doesNotMatch(source, /IconChevronDownOutline14/)
  // This half never hides chat rows from the page. Host 0.2.0-rc.2 renders no
  // row for a text-only injected context (dsh-client-ui-chat/lib/client.js:7719),
  // and the answer to that belongs to the Host's node filter, not to a DOM patch
  // of ours.
  assert.doesNotMatch(source, /data-reasoning-summary-hidden/)
  assert.doesNotMatch(source, /MutationObserver/)
  assert.doesNotMatch(source, /hideMarkedChatRows/)
})
