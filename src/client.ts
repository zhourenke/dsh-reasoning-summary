/**
 * Browser face for @zhourenke/dsh-reasoning-summary.
 *
 * The card deliberately uses the configurable-plugin slot owned by DSH's
 * official settings surface. It stages changes locally and writes only on
 * Save, while the model catalog is read live from the host API.
 *
 * The card chrome and the model list follow the current host's peer cards:
 * `PluginCard` (dsh-client-ui-settings-plugins) for the collapsible shell and
 * `SubagentModelSelectionCard` (same package) for the bordered model list with
 * provider groups, so this plugin's settings entry looks like the sibling
 * cards in the same settings page.
 */

interface Window {
  __ModuleLoader__: {
    load(definition: { id: string; factory: (require: (id: string) => any) => any }): void
  }
}

const NS = 'reasoning-summary'
const PLUGIN_ID = '@zhourenke/dsh-reasoning-summary'

window.__ModuleLoader__.load({
  id: PLUGIN_ID,
  factory: (require) => {
    const React: any = require('react')
    const e = React.createElement
    const { useEffect, useMemo, useState } = React
    const { IconChevronDownOutline14, IconTrashOutline16, Tag } = require('@deepseek-ai/dsh-client-ui-primitives')

    type Selection = { provider: string; model: string }
    type CatalogModel = { id: string; name?: string; description?: string }
    type CatalogGroup = { id: string; name?: string; models?: CatalogModel[] }
    /**
     * Direct answer of the Host `session/modelCatalog` Remote method. The
     * generated remote face answers `{ ok, value }` / `{ ok, error }` without a
     * second result envelope.
     */
    type CatalogResponse = {
      ok: boolean
      value?: { groups?: CatalogGroup[] }
      error?: { code?: string; message?: string }
    }
    /** The `remote.session` namespace service mounted by the Remote assembly. */
    type SessionFace = {
      modelCatalog(): Promise<CatalogResponse>
    }
    type Snapshot = {
      status: string
      value?: { models?: Selection[] }
      writable: boolean
    }
    type Scope = {
      getSnapshot(): Snapshot
      subscribe(listener: () => void): () => void
      set(field: string, value: unknown): Promise<void>
    }

    type LocaleValue = string | ((n: number) => string)
    const zh: Record<string, LocaleValue> = {
      title: '推理摘要',
      description: '为选定模型在调用工具前生成并传递行动摘要。',
      models: '触发模型',
      modelsHint: '模型目录中不可用且已启用的条目仍会保留显示。',
      loading: '正在加载模型目录…',
      retry: '重试',
      selected: '已选择 {n} 个模型',
      unavailable: '当前不可用',
      unavailableGroup: '已保存但当前不可用',
      removeModel: '删除模型',
      noModels: '当前没有可用的模型目录。',
      readOnly: '设置当前为只读。',
      save: '保存',
      saving: '保存中…',
      discard: '放弃更改',
      unsaved: '未保存',
      saveFailed: '保存失败，请重试。',
      expand: '展开',
      collapse: '收起',
      catalogFailed: '模型目录加载失败；已保存的选择不会被自动删除。',
    }
    const en: Record<string, LocaleValue> = {
      title: 'Reasoning summary',
      description: 'Require and relay an action summary before tool calls on selected models.',
      models: 'Trigger models',
      modelsHint: 'Enabled entries that are unavailable in the model catalog remain visible.',
      loading: 'Loading model catalog…',
      retry: 'Retry',
      selected: '{n} model(s) selected',
      unavailable: 'Currently unavailable',
      unavailableGroup: 'Saved but currently unavailable',
      removeModel: 'Remove model',
      noModels: 'No model catalog is currently available.',
      readOnly: 'Settings are read-only.',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard changes',
      unsaved: 'Unsaved',
      saveFailed: 'Save failed; please try again.',
      expand: 'Expand',
      collapse: 'Collapse',
      catalogFailed: 'The model catalog could not be loaded; saved selections were not removed.',
    }

    function translator(props: any): (key: string, ...args: any[]) => any {
      if (typeof props?.t === 'function') return props.t
      const language = typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh') ? zh : en
      return (key: string, ...args: any[]) => {
        const value: LocaleValue | string = language[key] ?? zh[key] ?? key
        const text = typeof value === 'function' ? value(Number(args[0] ?? 0)) : value
        return text.replace(/\{n\}/g, String(args[0] ?? 0))
      }
    }

    function keyOf(item: Selection): string {
      return `${item.provider}\u0000${item.model}`
    }

    function copySelections(value: any): Selection[] {
      return Array.isArray(value?.models)
        ? value.models.filter((item: any) => typeof item?.provider === 'string' && typeof item?.model === 'string')
          .map((item: any) => ({ provider: item.provider, model: item.model }))
        : []
    }

    function SummaryCard(props: any): any {
      const translate = typeof props?.t === 'function' ? props.t : translator(props)
      const t = (key: string, ...args: any[]) => {
        const value = typeof props?.t === 'function'
          ? translate(key, args.length > 0 ? { n: args[0] } : undefined)
          : translate(key, ...args)
        return String(value).replace(/\{n\}/g, String(args[0] ?? 0))
      }
      const scope = props.scope as Scope
      const sessionFace = props.sessionFace as () => SessionFace | undefined
      const [revision, setRevision] = useState(0)
      const [open, setOpen] = useState(false)
      const [dirty, setDirty] = useState(false)
      const [draftModels, setDraftModels] = useState(() => copySelections(scope.getSnapshot().value)) as [Selection[], (value: any) => void]
      const [saving, setSaving] = useState(false)
      const [failed, setFailed] = useState(false)
      const [catalog, setCatalog] = useState(null) as [CatalogGroup[] | null, (value: any) => void]
      const [catalogError, setCatalogError] = useState(null) as [string | null, (value: any) => void]

      useEffect(() => scope.subscribe(() => setRevision((value: number) => value + 1)), [scope])
      const snapshot = scope.getSnapshot()
      const value = snapshot.value ?? { models: [] }

      useEffect(() => {
        if (!dirty && snapshot.value) {
          setDraftModels(copySelections(snapshot.value))
          setFailed(false)
        }
      }, [revision, dirty, snapshot.value])

      const loadCatalog = async () => {
        setCatalogError(null)
        try {
          // The namespace is a Cordis service mounted by the Host Remote
          // assembly, so resolve it per call instead of caching a face that may
          // still be absent (or replaced) at activation time.
          const face = typeof sessionFace === 'function' ? sessionFace() : undefined
          if (!face || typeof face.modelCatalog !== 'function') {
            throw new Error('host remote.session namespace is unavailable')
          }
          const response = await face.modelCatalog()
          if (!response || typeof response.ok !== 'boolean') {
            throw new Error('host model catalog answered an unknown shape')
          }
          if (!response.ok) {
            throw new Error(response.error?.message ?? response.error?.code ?? 'host refused the model catalog request')
          }
          const groups = response.value?.groups
          if (!Array.isArray(groups)) throw new Error('host model catalog carried no provider groups')
          setCatalog(groups.filter((group: any) => typeof group?.id === 'string').map((group: any) => ({
            id: group.id,
            name: typeof group.name === 'string' ? group.name : group.id,
            models: Array.isArray(group.models) ? group.models.filter((model: any) => typeof model?.id === 'string') : [],
          })))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[reasoning-summary] model catalog load failed: ${message}`)
          setCatalogError(message)
          setCatalog(null)
        }
      }

      useEffect(() => { void loadCatalog() }, [])
      // Opening the card retries a load that ran before the namespace was ready.
      useEffect(() => { if (open && catalogError !== null) void loadCatalog() }, [open])

      const catalogKeys = useMemo(() => {
        if (!catalog) return null
        const result = new Set<string>()
        for (const group of catalog as CatalogGroup[]) for (const model of (group.models ?? []) as CatalogModel[]) result.add(keyOf({ provider: group.id, model: model.id }))
        return result
      }, [catalog])
      const selected = new Set(draftModels.map(keyOf))

      if (snapshot.status !== 'ready') return null

      const toggle = (item: Selection) => {
        const key = keyOf(item)
        setDraftModels((current: Selection[]) => current.some((entry: Selection) => keyOf(entry) === key)
          ? current.filter((entry: Selection) => keyOf(entry) !== key)
          : [...current, item])
        setDirty(true)
      }
      const removeStale = (item: Selection) => {
        const key = keyOf(item)
        setDraftModels((current: Selection[]) => current.filter((entry: Selection) => keyOf(entry) !== key))
        setDirty(true)
      }
      const save = async () => {
        if (!snapshot.writable || saving) return
        setSaving(true)
        setFailed(false)
        try {
          await scope.set('models', draftModels)
          setDirty(false)
        } catch {
          setFailed(true)
        } finally {
          setSaving(false)
        }
      }
      const discard = () => {
        setDraftModels(copySelections(value))
        setDirty(false)
        setFailed(false)
      }

      // Keep a saved route at its provider's position when the provider still
      // exists, and collect routes whose provider vanished into a trailing
      // "saved but unavailable" group — never at the top of the list.
      const staleByProvider = new Map<string, Selection[]>()
      const orphanStale: Selection[] = []
      for (const item of draftModels) {
        if (catalogKeys !== null && catalogKeys.has(keyOf(item))) continue
        const host = (catalog ?? []).find((group: CatalogGroup) => group.id === item.provider)
        if (host) {
          const list = staleByProvider.get(item.provider) ?? []
          list.push(item)
          staleByProvider.set(item.provider, list)
        } else {
          orphanStale.push(item)
        }
      }
      const renderStaleRow = (item: Selection) => e('div', { className: 'rs-model', key: `stale:${keyOf(item)}` },
        e('input', { type: 'checkbox', checked: true, disabled: !snapshot.writable || saving, onChange: () => toggle(item) }),
        e('span', null,
          e('span', { className: 'rs-model-name' }, `${item.provider} / ${item.model}`),
          e('span', { className: 'rs-route' }, t('unavailable')),
        ),
        e('button', {
          type: 'button', className: 'rs-icon-button rs-icon-button-danger',
          'aria-label': `${t('removeModel')}: ${item.provider} / ${item.model}`,
          title: t('removeModel'),
          disabled: !snapshot.writable || saving,
          onClick: () => removeStale(item),
        }, e(IconTrashOutline16, { size: 14 })),
      )

      return e('li', { className: `rs-card ${open ? 'rs-card-open' : ''}` },
        e('button', {
          type: 'button', className: 'rs-head', 'aria-expanded': open,
          'aria-label': `${t(open ? 'collapse' : 'expand')}: ${t('title')}`,
          onClick: () => setOpen(!open),
        },
          e('span', { className: 'rs-heading' },
            e('span', { className: 'rs-name' }, t('title')),
            e('span', { className: 'rs-description' }, t('description')),
          ),
          dirty ? e(Tag, { tone: 'neutral', className: 'rs-pending' }, t('unsaved')) : null,
          e(IconChevronDownOutline14, { className: `rs-chevron ${open ? 'rs-chevron-open' : ''}` }),
        ),
        open ? e('div', { className: 'rs-body' },
          !snapshot.writable ? e('p', { className: 'rs-readonly', role: 'status' }, t('readOnly')) : null,
          e('div', { className: 'rs-field' },
            e('div', { className: 'rs-model-title' },
              e('span', { className: 'rs-model-label' }, t('models')),
              e('span', { className: 'rs-count' }, t('selected', draftModels.length)),
            ),
            e('p', { className: 'rs-hint' }, t('modelsHint')),
            catalogError !== null ? e('div', { className: 'rs-catalog-error', role: 'alert' },
              e('span', null, `${t('catalogFailed')} (${catalogError})`),
              e('button', { type: 'button', disabled: saving, onClick: () => { void loadCatalog() } }, t('retry')),
            ) : null,
            catalog === null && catalogError === null ? e('p', { className: 'rs-notice', role: 'status' }, t('loading')) : null,
            (catalog && catalog.length > 0) || draftModels.length > 0 ? e('fieldset', { className: 'rs-models' },
              e('legend', null, t('models')),
              catalog?.map((group: CatalogGroup) => e('div', { className: 'rs-model-group', key: group.id },
                e('div', { className: 'rs-provider' }, group.name ?? group.id),
                (group.models ?? []).map((model: CatalogModel) => {
                  const item = { provider: group.id, model: model.id }
                  const checked = selected.has(keyOf(item))
                  return e('div', { className: 'rs-model', key: keyOf(item) },
                    e('input', { type: 'checkbox', checked, disabled: !snapshot.writable || saving, onChange: () => toggle(item) }),
                    e('span', null,
                      e('span', { className: 'rs-model-name' }, model.name && model.name !== model.id ? model.name : model.id),
                      e('span', { className: 'rs-route' }, `${group.id} / ${model.id}`),
                    ),
                  )
                }),
                (staleByProvider.get(group.id) ?? []).map(renderStaleRow),
              )),
              orphanStale.length > 0 ? e('div', { className: 'rs-model-group' },
                e('div', { className: 'rs-provider' }, t('unavailableGroup')),
                orphanStale.map(renderStaleRow),
              ) : null,
            ) : null,
            catalog && catalog.length === 0 && draftModels.length === 0 ? e('p', { className: 'rs-notice' }, t('noModels')) : null,
          ),
          e('div', { className: 'rs-footer' },
            failed ? e('p', { className: 'rs-failed', role: 'status' }, t('saveFailed')) : null,
            e('button', { type: 'button', className: 'rs-discard', disabled: !dirty || saving, onClick: discard }, t('discard')),
            e('button', { type: 'button', className: 'rs-save', disabled: !dirty || saving || !snapshot.writable, onClick: () => { void save() } }, saving ? t('saving') : t('save')),
          ),
        ) : null,
      )
    }

    const css = `
      .rs-card { border: .5px solid var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-3); border-radius: 16px; list-style: none; transition: border-color .16s, background .16s; }
      .rs-card:hover { border-color: var(--dsw-alias-label-dimmed); }
      .rs-card-open { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }
      .rs-head { appearance: none; width: 100%; font: inherit; color: inherit; text-align: left; cursor: pointer; background: transparent; border: 0; border-radius: 12px; display: flex; align-items: center; gap: 12px; padding: 14px 16px; }
      .rs-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
      .rs-heading { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
      .rs-name { color: var(--dsw-alias-label-primary); font-size: 15px; font-weight: 600; line-height: 1.4; }
      .rs-description { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 1.5; }
      .rs-pending { flex: none; }
      .rs-chevron { color: var(--dsw-alias-label-tertiary); flex: none; transition: transform .16s; }
      .rs-chevron-open { transform: rotate(180deg); }
      .rs-body { border-top: .5px solid var(--dsw-alias-border-l2); margin: 0 16px; padding-bottom: 8px; }
      .rs-readonly { color: var(--dsw-alias-label-tertiary); margin: 12px 0 0; font-size: 12px; line-height: 1.5; }
      .rs-field { display: grid; gap: 10px; padding: 12px 0; }
      .rs-model-title { display: flex; align-items: center; gap: 8px; }
      .rs-model-label { min-width: 0; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; line-height: 1.5; }
      .rs-count { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform); border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 500; line-height: 17px; white-space: nowrap; margin-left: auto; }
      .rs-hint, .rs-notice { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
      .rs-catalog-error { color: var(--dsw-alias-label-error); display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 12px; line-height: 1.5; }
      .rs-catalog-error button { color: var(--dsw-alias-brand-primary); cursor: pointer; background: transparent; border: 0; padding: 0; font: inherit; }
      .rs-models { border: .5px solid var(--dsw-alias-border-l4); border-radius: 8px; display: grid; gap: 6px; min-width: 0; max-height: 280px; margin: 0; padding: 10px; overflow: auto; }
      .rs-models legend { color: var(--dsw-alias-label-secondary); padding: 0 4px; font-size: 12px; }
      .rs-model-group { display: grid; gap: 6px; }
      .rs-model-group + .rs-model-group { border-top: .5px solid var(--dsw-alias-border-l3); margin-top: 4px; padding-top: 10px; }
      .rs-provider { color: var(--dsw-alias-label-tertiary); padding: 0 6px; font-size: 11px; font-weight: 500; }
      .rs-model { cursor: pointer; border-radius: 6px; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; min-width: 0; padding: 6px; display: grid; }
      .rs-model:hover { background: var(--dsw-alias-bg-layer-4); }
      .rs-model-name, .rs-route { text-overflow: ellipsis; white-space: nowrap; display: block; overflow: hidden; }
      .rs-model-name { color: var(--dsw-alias-label-primary); font-size: 13px; }
      .rs-route { color: var(--dsw-alias-label-tertiary); margin-top: 2px; font-size: 11px; }
      .rs-icon-button { box-sizing: border-box; width: 28px; height: 28px; color: var(--dsw-alias-label-tertiary); cursor: pointer; background: transparent; border: none; border-radius: 6px; justify-content: center; align-items: center; display: inline-flex; }
      .rs-icon-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .rs-icon-button:disabled { cursor: default; opacity: .4; }
      .rs-icon-button-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
      .rs-discard, .rs-save { appearance: none; border: 1px solid transparent; border-radius: 8px; padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; }
      .rs-discard { border-color: var(--dsw-alias-border-l2); background: none; color: var(--dsw-alias-label-secondary); }
      .rs-discard:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
      .rs-save { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
      .rs-footer { border-top: .5px solid var(--dsw-alias-border-l2); display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 0 4px; }
      .rs-failed { min-width: 0; color: var(--dsw-alias-label-error); flex: 1; margin: 0; font-size: 12px; line-height: 1.5; }
      .rs-discard:disabled, .rs-save:disabled { opacity: .4; cursor: default; }
      .rs-discard:focus-visible, .rs-save:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
    `

    function apply(ctx: any): void {
      if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="reasoning-summary"]')) {
        const style = document.createElement('style')
        style.dataset.pluginCss = 'reasoning-summary'
        style.textContent = css
        document.head.appendChild(style)
      }
      const slots = ctx.slots
      const settingsScope = ctx.settingsScope
      const locale = ctx.locale
      if (!slots || !settingsScope || !locale) return
      const scope = settingsScope.bind({ namespace: NS })
      const t = locale.bind(NS)
      // The Host model catalog lives on the `remote.session` namespace service.
      // Resolve it through the container per call: the namespace is mounted
      // asynchronously by the Remote assembly and is replaced on reconnect, so
      // a reference captured at activation time can be absent or stale.
      const sessionFace = (): SessionFace | undefined => {
        const viaNamespace = typeof ctx.get === 'function' ? ctx.get('remote.session') : undefined
        if (viaNamespace !== undefined) return viaNamespace as SessionFace
        const remote = typeof ctx.get === 'function' ? ctx.get('remote') : ctx.remote
        const viaParent = remote === undefined || remote === null ? undefined : remote.session
        return viaParent as SessionFace | undefined
      }
      ctx.effect(() => locale.register(NS, { zh, en }), 'reasoning-summary: locale dictionaries')
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: NS,
        locale: NS,
        inject: () => ({ scope, sessionFace, t }),
      }, (props: any) => e(SummaryCard, { ...props, scope, sessionFace, t })))
    }

    // `remote.session` gates activation on the namespace being mounted, so the
    // first catalog read cannot race the Host Remote assembly.
    return { apply, inject: ['slots', 'settingsScope', 'locale', 'remote', 'remote.session'] }
  },
})