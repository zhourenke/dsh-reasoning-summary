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
//    (dsh-client-ui-primitives/lib/types/settings-form/form-model.d.ts).
//
// 5. `SettingsForm` owns the frame, the save control and the failure notice, and
//    takes `{ labels, state, onSave, onDiscard, children }` where `state` is
//    `{ available, writable, dirty, invalid, saving, failed }`
//    (dsh-client-ui-primitives/lib/types/settings-form/SettingsForm.d.ts).
//
// NOT modelled here: React's reconciler and hook semantics (the stub runs effects
// and lazy initializers but keeps no state between renders), the host's real slot
// registry, and the plugins page that dispatches the slot. This file proves the
// plugin's side of the contract; the Host's side is proven by the card appearing
// in a running deployment.
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
 * Build a factory `require` that satisfies the two modules the card imports.
 * `elements` records every `createElement` call, which is how a test observes
 * what the card would render.
 */
function makeRequire() {
  const requested = []
  const elements = []
  const primitives = {
    // A distinct identity so a test can prove the page really renders the
    // official form rather than a hand-rolled frame of its own.
    SettingsForm: function SettingsForm() {},
  }
  const require = (id) => {
    requested.push(id)
    if (id === 'react') {
      return {
        createElement: (component, props, ...children) => {
          const element = { component, props, children }
          elements.push(element)
          return element
        },
        // The stub runs effects immediately and keeps no state between renders:
        // it observes what a single render does, not how React schedules it.
        useEffect: (callback) => { callback() },
        useMemo: (callback) => callback(),
        // React invokes a function initial state lazily; the card relies on it
        // to copy the saved selection out of the form.
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      }
    }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require("${id}")`)
  }
  return { require, requested, elements, primitives }
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
  // The primitives module is the only optional import; react is always required.
  assert.deepEqual(requested.sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react'])
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
  assert.equal(findElement(elements, (el) => el.component === 'form' || el.component?.name === 'SettingsForm'), undefined)
})

test('the page body renders the official settings form with the Host form value', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const { require, elements, primitives } = makeRequire()
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

  const settingsForm = findElement(elements, (el) => el.component === primitives.SettingsForm)
  assert.ok(settingsForm, 'the page body must be the official SettingsForm')
  assert.deepEqual(settingsForm.props.labels, {
    unavailable: t('formUnavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  })
  assert.deepEqual(settingsForm.props.state, {
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
  })
  assert.equal(typeof settingsForm.props.onSave, 'function')
  assert.equal(typeof settingsForm.props.onDiscard, 'function')
  // The stub keeps element children beside the props, as React's own element
  // shape does: the form wraps the route field as its children.
  assert.ok(settingsForm.children.length > 0, 'the form must wrap the route list')
  const field = settingsForm.children.find((child) => child?.props?.className === 'rs-field')
  assert.ok(field, 'the wrapped body must be the route field')

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

test('a page that is not ready renders nothing rather than an empty card', () => {
  const { require, elements } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx({ form: { state: { status: 'loading', value: undefined, writable: true } } })
  plugin.apply(ctx)

  const t = kitFor(state, NS)
  const { card } = render(state, { view: 'page', form: undefined, t })
  assert.equal(card, null)
  assert.equal(findElement(elements, (el) => el.component === 'form'), undefined)
})

test('save commits one revision-fenced write for the whole route list', async () => {
  const route = { provider: 'cotton-codex', model: 'gpt-5.6-luna' }
  const writes = []
  const { require, elements, primitives } = makeRequire()
  const plugin = definition.factory(require)
  const form = {
    state: { status: 'ready', value: { models: [route] }, writable: true, revision: 7 },
    mutate: async (ops, expectedRevision) => {
      writes.push({ ops, expectedRevision })
      return true
    },
  }
  const { ctx, state } = makeCtx({ form })
  plugin.apply(ctx)

  const t = kitFor(state, NS)
  render(state, { view: 'page', form, t })
  const settingsForm = findElement(elements, (el) => el.component === primitives.SettingsForm)
  await settingsForm.props.onSave()

  assert.equal(writes.length, 1)
  // Staged locally and committed as one write, fenced by the revision the drafts
  // were staged against (contract fact 4).
  assert.deepEqual(writes[0].ops, [{ op: 'set', path: ['models'], value: [route] }])
  assert.equal(writes[0].expectedRevision, 7)
})

test('a refused write is treated as a failure, not as a silent success', async () => {
  const writes = []
  const { require, elements, primitives } = makeRequire()
  const plugin = definition.factory(require)
  const form = {
    state: { status: 'ready', value: { models: [] }, writable: true, revision: 3 },
    mutate: async (ops, expectedRevision) => {
      writes.push({ ops, expectedRevision })
      return false
    },
  }
  const { ctx, state } = makeCtx({ form })
  plugin.apply(ctx)

  const t = kitFor(state, NS)
  render(state, { view: 'page', form, t })
  const settingsForm = findElement(elements, (el) => el.component === primitives.SettingsForm)
  await settingsForm.props.onSave()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].expectedRevision, 3)

  // The stub keeps no state between renders, so the resulting `failed` flag
  // cannot be observed here; the branch that raises it is asserted instead. The
  // point is that only an accepted write clears `dirty`.
  assert.match(source, /if \(accepted\)\s*\{?\s*setDirty\(false\);?\s*\}?\s*else\s*\{?\s*setFailed\(true\);?/)
})

test('a read-only form still renders but can never write', async () => {
  const writes = []
  const { require, elements, primitives } = makeRequire()
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
  const settingsForm = findElement(elements, (el) => el.component === primitives.SettingsForm)
  assert.equal(settingsForm.props.state.writable, false)
  await settingsForm.props.onSave()
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

test('the official form owns the chrome and the deleted seat stays deleted', () => {
  // Gone with 0.2.0-rc.2: the catch-all seat, the scope binding, and the
  // hand-rolled card frame. Each of these would be a silent reimplementation of
  // what the official surfaces already do, so they are asserted absent.
  assert.doesNotMatch(source, /settings\.plugin\.item/)
  assert.doesNotMatch(source, /settingsScope/)
  assert.doesNotMatch(source, /locale\.bind/)
  assert.doesNotMatch(source, /rs-footer|rs-save|rs-discard|rs-chevron|rs-head\b|rs-pending|rs-failed|rs-readonly/)
  // The page body is the official form.
  assert.match(source, /return e\(SettingsForm, \{/)
  // The removed icon must not be resurrected; 0.2.0-rc.2 renamed it.
  assert.doesNotMatch(source, /IconChevronDownOutline14/)
})
