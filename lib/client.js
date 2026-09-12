"use strict";
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
 * cards in the same settings page. Routes that vanished from the catalog stay
 * listed as unchecked-able rows in a trailing "saved but currently
 * unavailable" group, exactly like the Subagent card: the only way to remove
 * one is to uncheck it and save; there is no separate delete control.
 */
// Browser halves are plain loader scripts and cannot import the host half, so
// both identity strings are literals here. `NS` must stay byte-identical to
// `SETTINGS_NAMESPACE` in src/index.ts: it keys the settings namespace the host
// registers and the slot this card is dispatched by. `PLUGIN_ID` must match the
// package name in package.json. client.test.mjs asserts both spellings.
const NS = 'reasoning-summary';
const PLUGIN_ID = '@zhourenke/dsh-reasoning-summary';
window.__ModuleLoader__.load({
    id: PLUGIN_ID,
    factory: (require) => {
        const React = require('react');
        const e = React.createElement;
        const { useEffect, useMemo, useState } = React;
        const { IconChevronDownOutline14, Tag } = require('@deepseek-ai/dsh-client-ui-primitives');
        const zh = {
            title: '推理摘要',
            description: '为选定模型在调用工具前生成并传递行动摘要。',
            models: '触发模型',
            modelsHint: '模型目录中不可用且已启用的条目仍会保留显示。',
            loading: '正在加载模型目录…',
            retry: '重试',
            selected: '已选择 {n} 个模型',
            unavailable: '当前不可用',
            unavailableGroup: '已保存但当前不可用',
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
        };
        const en = {
            title: 'Reasoning summary',
            description: 'Require and relay an action summary before tool calls on selected models.',
            models: 'Trigger models',
            modelsHint: 'Enabled entries that are unavailable in the model catalog remain visible.',
            loading: 'Loading model catalog…',
            retry: 'Retry',
            selected: '{n} model(s) selected',
            unavailable: 'Currently unavailable',
            unavailableGroup: 'Saved but currently unavailable',
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
        };
        function keyOf(item) {
            return `${item.provider}\u0000${item.model}`;
        }
        function copySelections(value) {
            return Array.isArray(value?.models)
                ? value.models.filter((item) => typeof item?.provider === 'string' && typeof item?.model === 'string')
                    .map((item) => ({ provider: item.provider, model: item.model }))
                : [];
        }
        function SummaryCard(props) {
            // The slot render closure always injects the locale-bound translator, so
            // the card reads `props.t` directly. The host contract is
            // `t(key, params?)`; `{n}` is substituted again here because the bound
            // translator may hand back the raw dictionary entry.
            const translate = props.t;
            const t = (key, ...args) => String(translate(key, args.length > 0 ? { n: args[0] } : undefined)).replace(/\{n\}/g, String(args[0] ?? 0));
            const scope = props.scope;
            const sessionFace = props.sessionFace;
            const [revision, setRevision] = useState(0);
            const [open, setOpen] = useState(false);
            const [dirty, setDirty] = useState(false);
            const [draftModels, setDraftModels] = useState(() => copySelections(scope.getSnapshot().value));
            const [saving, setSaving] = useState(false);
            const [failed, setFailed] = useState(false);
            const [catalog, setCatalog] = useState(null);
            const [catalogError, setCatalogError] = useState(null);
            useEffect(() => scope.subscribe(() => setRevision((value) => value + 1)), [scope]);
            const snapshot = scope.getSnapshot();
            const value = snapshot.value ?? { models: [] };
            useEffect(() => {
                if (!dirty && snapshot.value) {
                    setDraftModels(copySelections(snapshot.value));
                    setFailed(false);
                }
            }, [revision, dirty, snapshot.value]);
            const loadCatalog = async () => {
                setCatalogError(null);
                try {
                    // The namespace is a Cordis service mounted by the Host Remote
                    // assembly, so resolve it per call instead of caching a face that may
                    // still be absent (or replaced) at activation time.
                    const face = typeof sessionFace === 'function' ? sessionFace() : undefined;
                    if (!face || typeof face.modelCatalog !== 'function') {
                        throw new Error('host remote.session namespace is unavailable');
                    }
                    const response = await face.modelCatalog();
                    if (!response || typeof response.ok !== 'boolean') {
                        throw new Error('host model catalog answered an unknown shape');
                    }
                    if (!response.ok) {
                        throw new Error(response.error?.message ?? response.error?.code ?? 'host refused the model catalog request');
                    }
                    const groups = response.value?.groups;
                    if (!Array.isArray(groups))
                        throw new Error('host model catalog carried no provider groups');
                    setCatalog(groups.filter((group) => typeof group?.id === 'string').map((group) => ({
                        id: group.id,
                        name: typeof group.name === 'string' ? group.name : group.id,
                        models: Array.isArray(group.models) ? group.models.filter((model) => typeof model?.id === 'string') : [],
                    })));
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.warn(`[reasoning-summary] model catalog load failed: ${message}`);
                    setCatalogError(message);
                    setCatalog(null);
                }
            };
            useEffect(() => { void loadCatalog(); }, []);
            // Opening the card retries a load that ran before the namespace was ready.
            useEffect(() => { if (open && catalogError !== null)
                void loadCatalog(); }, [open]);
            const catalogKeys = useMemo(() => {
                if (!catalog)
                    return null;
                const result = new Set();
                for (const group of catalog)
                    for (const model of (group.models ?? []))
                        result.add(keyOf({ provider: group.id, model: model.id }));
                return result;
            }, [catalog]);
            const selected = new Set(draftModels.map(keyOf));
            if (snapshot.status !== 'ready')
                return null;
            const toggle = (item) => {
                const key = keyOf(item);
                setDraftModels((current) => current.some((entry) => keyOf(entry) === key)
                    ? current.filter((entry) => keyOf(entry) !== key)
                    : [...current, item]);
                setDirty(true);
            };
            const save = async () => {
                if (!snapshot.writable || saving)
                    return;
                setSaving(true);
                setFailed(false);
                try {
                    await scope.set('models', draftModels);
                    setDirty(false);
                }
                catch {
                    setFailed(true);
                }
                finally {
                    setSaving(false);
                }
            };
            const discard = () => {
                setDraftModels(copySelections(value));
                setDirty(false);
                setFailed(false);
            };
            // Candidate rows mirror the Subagent card exactly: a row exists for every
            // catalog model plus every saved route that is no longer in the catalog
            // (whether its provider survived or not). Unavailable routes collect in a
            // trailing group and keep their checkbox; unchecking one keeps the row
            // visible until Save commits the removal, so a vanished route is never
            // silently dropped.
            const effective = new Map();
            for (const item of copySelections(value))
                effective.set(keyOf(item), item);
            for (const item of draftModels)
                effective.set(keyOf(item), item);
            const unavailable = [];
            for (const item of effective.values()) {
                if (catalogKeys !== null && catalogKeys.has(keyOf(item)))
                    continue;
                unavailable.push(item);
            }
            const renderRow = (providerName, item, available, modelName) => e('label', { className: 'rs-model', key: keyOf(item) }, e('input', { type: 'checkbox', checked: selected.has(keyOf(item)), disabled: !snapshot.writable || saving, onChange: () => toggle(item) }), e('span', null, e('span', { className: 'rs-model-name' }, modelName), e('span', { className: 'rs-route' }, `${providerName} · ${item.provider}/${item.model}`)), !available ? e('span', { className: 'rs-unavailable' }, t('unavailable')) : null);
            return e('li', { className: `rs-card ${open ? 'rs-card-open' : ''}` }, e('button', {
                type: 'button', className: 'rs-head', 'aria-expanded': open,
                'aria-label': `${t(open ? 'collapse' : 'expand')}: ${t('title')}`,
                onClick: () => setOpen(!open),
            }, e('span', { className: 'rs-heading' }, e('span', { className: 'rs-name' }, t('title')), e('span', { className: 'rs-description' }, t('description'))), dirty ? e(Tag, { tone: 'neutral', className: 'rs-pending' }, t('unsaved')) : null, e(IconChevronDownOutline14, { className: `rs-chevron ${open ? 'rs-chevron-open' : ''}` })), open ? e('div', { className: 'rs-body' }, !snapshot.writable ? e('p', { className: 'rs-readonly', role: 'status' }, t('readOnly')) : null, e('div', { className: 'rs-field' }, e('div', { className: 'rs-model-title' }, e('span', { className: 'rs-model-label' }, t('models')), e('span', { className: 'rs-count' }, t('selected', draftModels.length))), e('p', { className: 'rs-hint' }, t('modelsHint')), catalogError !== null ? e('div', { className: 'rs-catalog-error', role: 'alert' }, e('span', null, `${t('catalogFailed')} (${catalogError})`), e('button', { type: 'button', disabled: saving, onClick: () => { void loadCatalog(); } }, t('retry'))) : null, catalog === null && catalogError === null ? e('p', { className: 'rs-notice', role: 'status' }, t('loading')) : null, (catalog && catalog.length > 0) || effective.size > 0 ? e('fieldset', { className: 'rs-models' }, e('legend', null, t('models')), catalog?.map((group) => e('div', { className: 'rs-model-group', key: group.id }, e('div', { className: 'rs-provider' }, group.name ?? group.id), (group.models ?? []).map((model) => {
                const item = { provider: group.id, model: model.id };
                return renderRow(group.name ?? group.id, item, true, model.name && model.name !== model.id ? model.name : model.id);
            }))), unavailable.length > 0 ? e('div', { className: 'rs-model-group' }, e('div', { className: 'rs-provider' }, t('unavailableGroup')), unavailable.map((item) => renderRow(item.provider, item, false, item.model))) : null) : null, catalog && catalog.length === 0 && effective.size === 0 ? e('p', { className: 'rs-notice' }, t('noModels')) : null), e('div', { className: 'rs-footer' }, failed ? e('p', { className: 'rs-failed', role: 'status' }, t('saveFailed')) : null, e('button', { type: 'button', className: 'rs-discard', disabled: !dirty || saving, onClick: discard }, t('discard')), e('button', { type: 'button', className: 'rs-save', disabled: !dirty || saving || !snapshot.writable, onClick: () => { void save(); } }, saving ? t('saving') : t('save')))) : null);
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
      .rs-unavailable { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
      .rs-discard, .rs-save { appearance: none; border: 1px solid transparent; border-radius: 8px; padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; }
      .rs-discard { border-color: var(--dsw-alias-border-l2); background: none; color: var(--dsw-alias-label-secondary); }
      .rs-discard:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
      .rs-save { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
      .rs-footer { border-top: .5px solid var(--dsw-alias-border-l2); display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 0 4px; }
      .rs-failed { min-width: 0; color: var(--dsw-alias-label-error); flex: 1; margin: 0; font-size: 12px; line-height: 1.5; }
      .rs-discard:disabled, .rs-save:disabled { opacity: .4; cursor: default; }
      .rs-discard:focus-visible, .rs-save:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
    `;
        function apply(ctx) {
            if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="reasoning-summary"]')) {
                const style = document.createElement('style');
                style.dataset.pluginCss = 'reasoning-summary';
                style.textContent = css;
                document.head.appendChild(style);
            }
            const slots = ctx.slots;
            const settingsScope = ctx.settingsScope;
            const locale = ctx.locale;
            if (!slots || !settingsScope || !locale)
                return;
            const scope = settingsScope.bind({ namespace: NS });
            const t = locale.bind(NS);
            // The Host model catalog lives on the `remote.session` namespace service.
            // Resolve it through the container per call: the namespace is mounted
            // asynchronously by the Remote assembly and is replaced on reconnect, so
            // a reference captured at activation time can be absent or stale.
            const sessionFace = () => {
                const viaNamespace = typeof ctx.get === 'function' ? ctx.get('remote.session') : undefined;
                if (viaNamespace !== undefined)
                    return viaNamespace;
                const remote = typeof ctx.get === 'function' ? ctx.get('remote') : ctx.remote;
                const viaParent = remote === undefined || remote === null ? undefined : remote.session;
                return viaParent;
            };
            ctx.effect(() => locale.register(NS, { zh, en }), 'reasoning-summary: locale dictionaries');
            ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
                name: 'settings.plugin.item',
                key: NS,
                locale: NS,
                inject: () => ({ scope, sessionFace, t }),
            }, (props) => e(SummaryCard, { ...props, scope, sessionFace, t })));
        }
        // `remote.session` gates activation on the namespace being mounted, so the
        // first catalog read cannot race the Host Remote assembly.
        return { apply, inject: ['slots', 'settingsScope', 'locale', 'remote', 'remote.session'] };
    },
});
