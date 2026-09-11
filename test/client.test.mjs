import test from 'node:test'
import assert from 'node:assert/strict'

// The browser half is a plain script: it registers itself through
// `window.__ModuleLoader__.load(...)` at module scope, so the stub must exist
// before the module is evaluated. This is the only test that executes
// `lib/client.js`; the rest assert on its source and on the Host half.
const definitions = []
globalThis.window = { __ModuleLoader__: { load: (definition) => definitions.push(definition) } }
await import('../lib/client.js')

const definition = definitions[0]

/** Build a factory `require` that satisfies the two modules the card imports. */
function makeRequire(icons = { IconChevronDownOutline14: () => ({}) }) {
  const requested = []
  const require = (id) => {
    requested.push(id)
    if (id === 'react') {
      return {
        createElement: () => ({}),
        useEffect: () => {},
        useMemo: (callback) => callback(),
        useState: (initial) => [initial, () => {}],
      }
    }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return icons
    throw new Error(`unexpected require("${id}")`)
  }
  return { require, requested }
}

/** Minimal stand-in for the React face the factory returns. */
function makeCtx(options = {}) {
  const state = { injected: [], registered: [], locales: [], effects: 0, styleAppends: 0 }
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
    settingsScope: { bind: ({ namespace }) => ({ namespace }) },
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
  return { ctx, state }
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
  const { ctx, state } = makeCtx()
  plugin.apply(ctx)

  assert.deepEqual(state.injected, ['settings.plugin.item'])
  assert.equal(state.registered.length, 1)

  const { slotDefinition, render } = state.registered[0]
  assert.equal(slotDefinition.name, 'settings.plugin.item')
  assert.equal(slotDefinition.key, 'reasoning-summary')
  assert.equal(slotDefinition.locale, 'reasoning-summary')
  assert.equal(typeof render, 'function')

  // The card receives its scope, translator, and catalog accessor as props.
  const props = slotDefinition.inject()
  assert.equal(props.scope.namespace, 'reasoning-summary')
  assert.equal(props.t('title'), 'reasoning-summary:title')

  assert.equal(state.locales.length, 1)
  assert.equal(state.locales[0].namespace, 'reasoning-summary')
  assert.ok(state.locales[0].dictionaries.zh)
  assert.ok(state.locales[0].dictionaries.en)
  assert.equal(state.effects, 1)
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
