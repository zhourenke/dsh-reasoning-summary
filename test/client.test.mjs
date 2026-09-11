import test from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// The host contracts this file models, as measured from the installed
// 0.1.5-rc.1 packages. Keep the citations when editing: a mock that drifts from
// the real contract hides defects instead of catching them (a "false green" —
// see PLUGIN_RELEASE_GUIDE.md §4.3).
//
// 1. The card seat `settings.plugin.item` is declared at RUNTIME by the Plugins
//    settings section, not by the settings domain package:
//      @deepseek-ai/dsh-client-ui-settings-plugins/lib/types/client/slot-contract.d.ts
//        'settings.plugin.item': { kind: 'keyed'; scope: 'root';
//                                  owner: SettingsPluginItemOwnerProps }
//    `SettingsPluginItemOwnerProps` is a marker (`children?: never`), i.e. the
//    section passes NO props of its own — every value the card needs must arrive
//    through the plugin's own `inject()` face. The same package's
//    contract/slots.d.ts owns the neighbouring seats (settings.plugins.tab,
//    settings.section, settings.general.item, ...).
//
// 2. Registration shape, taken from that package's own client.js, which
//    registers the Bash / AgentLoop / SubagentModelSelection / WebSearch cards
//    exactly this way:
//      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
//        { name: 'settings.plugin.item', key: <settings namespace>,
//          locale: NS, inject: () => face },
//        Card,
//      ))
//    Official registrants yield the register result from a generator callback,
//    so `register` returns a disposer; `slots.inject` runs its callback inside
//    the slot's registration scope.
//
// 3. Dispatch is BY NAMESPACE. The tab renders
//      renderSlot('settings.plugin.item', {}, { entryKey: ns })
//    once per namespace the Host serves, so what appears is the INTERSECTION of
//    the namespaces the Host serves and the cards registered under them; a card
//    whose namespace the Host does not serve is never dispatched and leaves no
//    trace (dsh-client-ui-settings-plugins/lib/types/client/tab-store.d.ts).
//    That is why the Host half must register the same namespace — see
//    `settings.register(SETTINGS_NAMESPACE, Config)` in src/index.ts.
//
// 4. `ctx.settingsScope.bind(spec)` takes `{ namespace, decode? }` and returns a
//    scope whose measured surface is getSnapshot / subscribe / set / unset /
//    mutate, over a snapshot of
//      { status: 'loading' | 'ready' | 'unavailable', value, base, user,
//        revision, writable, mode }
//    (dsh-client-ui-settings/lib/types/client/settings-contract.d.ts). The card
//    returns null unless `status === 'ready'`, so an unanswered Host renders
//    nothing rather than an empty card.
//
// NOT modelled here: React's reconciler and hook semantics (the stub only
// invokes lazy state initializers and memo callbacks), the host's real slot
// registry, and the tab that dispatches the slot. This file proves the plugin's
// side of the contract; the Host's side is proven by the card appearing in a
// running deployment.
// ---------------------------------------------------------------------------

// The browser half is a plain script: it registers itself through
// `window.__ModuleLoader__.load(...)` at module scope, so the stub must exist
// before the module is evaluated. This is the only test that executes
// `lib/client.js`; the rest assert on its source and on the Host half.
const definitions = []
globalThis.window = { __ModuleLoader__: { load: (definition) => definitions.push(definition) } }
await import('../lib/client.js')

const definition = definitions[0]

/**
 * Build a factory `require` that satisfies the two modules the card imports.
 * `elements` records every `createElement` call, which is how a test observes
 * what the card would render.
 */
function makeRequire(icons = { IconChevronDownOutline14: () => ({}), IconTrashOutline16: () => ({}), Tag: (props) => props?.children ?? null }) {
  const requested = []
  const elements = []
  const require = (id) => {
    requested.push(id)
    if (id === 'react') {
      return {
        createElement: (component, props, ...children) => {
          const element = { component, props, children }
          elements.push(element)
          return element
        },
        useEffect: () => {},
        useMemo: (callback) => callback(),
        // React invokes a function initial state lazily; the card relies on it
        // to copy the saved selection out of the snapshot.
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      }
    }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return icons
    throw new Error(`unexpected require("${id}")`)
  }
  return { require, requested, elements }
}

/** A `ready` snapshot with no saved model routes — the shape the Host serves. */
function readySnapshot(value = { models: [] }) {
  return { status: 'ready', value, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' }
}

/**
 * Minimal stand-in for the client services the browser half touches, shaped
 * after the measured contracts above. `options.snapshot` overrides the settings
 * snapshot the card reads.
 */
function makeCtx(options = {}) {
  const state = { injected: [], registered: [], locales: [], effects: 0, bindSpecs: [], styleAppends: 0 }
  const snapshot = options.snapshot ?? readySnapshot(options.value)
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => {},
    unset: async () => {},
    mutate: async () => {},
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
    settingsScope: {
      bind: (spec) => {
        state.bindSpecs.push(spec)
        return scope
      },
      describe: () => ({ namespaces: ['reasoning-summary'] }),
    },
    locale: {
      bind: (namespace) => (key) => `${namespace}:${key}`,
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
  return { ctx, state, scope }
}

test('the browser half registers itself with the host ModuleLoader', () => {
  assert.equal(definitions.length, 1)
  assert.equal(definition.id, '@zhourenke/dsh-reasoning-summary')
  assert.equal(typeof definition.factory, 'function')
})

test('the factory returns the plugin contract and requests only host modules', () => {
  const { require, requested } = makeRequire()
  const plugin = definition.factory(require)
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'settingsScope', 'locale', 'remote', 'remote.session'])
  // The icon module is the only optional import; react is always required.
  assert.deepEqual(requested.sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react'])
})

test('apply claims the configurable-plugin slot for its settings namespace', () => {
  const { require } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state, scope } = makeCtx()
  plugin.apply(ctx)

  assert.deepEqual(state.injected, ['settings.plugin.item'])
  assert.equal(state.registered.length, 1)

  const { slotDefinition, render } = state.registered[0]
  assert.equal(slotDefinition.name, 'settings.plugin.item')
  // The key IS the settings namespace the Host half registers (contract fact 3).
  assert.equal(slotDefinition.key, 'reasoning-summary')
  assert.equal(slotDefinition.locale, 'reasoning-summary')
  assert.equal(typeof render, 'function')

  // The scope is bound with the measured bind spec (`{ namespace, decode? }`),
  // not with a property the plugin invents on the returned scope.
  assert.deepEqual(state.bindSpecs, [{ namespace: 'reasoning-summary' }])

  // The face the slot injects carries exactly what the card needs.
  const props = slotDefinition.inject()
  assert.equal(props.scope, scope)
  assert.equal(props.t('title'), 'reasoning-summary:title')
  assert.equal(typeof props.sessionFace, 'function')

  assert.equal(state.locales.length, 1)
  assert.equal(state.locales[0].namespace, 'reasoning-summary')
  assert.ok(state.locales[0].dictionaries.zh)
  assert.ok(state.locales[0].dictionaries.en)
  assert.equal(state.effects, 1)
})

test('the slot mount forwards the injected face to the card', () => {
  const { require, elements } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx()
  plugin.apply(ctx)

  // The section passes no props of its own (contract fact 1), so the render
  // closure is what has to hand the card its scope, translator and catalog
  // face. React would call the returned element's component with these props.
  const element = state.registered[0].render({})
  assert.equal(typeof element.component, 'function')

  const card = element.component(element.props)
  assert.ok(card, 'a ready snapshot must render a card element')
  assert.ok(elements.length > 1, 'the card must build its own element tree')
  assert.equal(elements[0].component, element.component)
  assert.equal(element.props.t('title'), 'reasoning-summary:title')
  assert.equal(typeof element.props.sessionFace, 'function')
  assert.ok(element.props.scope && typeof element.props.scope.getSnapshot === 'function')
})

test('the card renders nothing until the Host answers with a ready snapshot', () => {
  const { require, elements } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx({ snapshot: { status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: true, mode: 'host' } })
  plugin.apply(ctx)

  const element = state.registered[0].render({})
  const card = element.component(element.props)
  assert.equal(card, null)
  assert.equal(elements.length, 1, 'only the card element itself may be created')
})

test('the catalog accessor resolves the remote session namespace service', () => {
  const face = { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) }
  const { require } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx({ viaNamespace: face })
  plugin.apply(ctx)

  const props = state.registered[0].slotDefinition.inject()
  assert.equal(props.sessionFace(), face)
})

test('the catalog accessor falls back to the remote parent service', () => {
  const face = { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) }
  const { require } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx({ viaRemoteParent: { session: face } })
  plugin.apply(ctx)

  const props = state.registered[0].slotDefinition.inject()
  assert.equal(props.sessionFace(), face)
})

test('the catalog accessor can read the namespace as a container property', () => {
  const face = { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) }
  const { require } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx({ withoutGet: true, propertyParent: face })
  plugin.apply(ctx)

  const props = state.registered[0].slotDefinition.inject()
  assert.equal(props.sessionFace(), face)
})

test('the catalog accessor stays undefined while the namespace is unmounted', () => {
  const { require } = makeRequire()
  const plugin = definition.factory(require)
  const { ctx, state } = makeCtx()
  plugin.apply(ctx)

  const props = state.registered[0].slotDefinition.inject()
  assert.equal(props.sessionFace(), undefined)
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
    assert.match(created[0].textContent, /\.rs-/)

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
