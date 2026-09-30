"use strict";
/**
 * Browser face for @zhourenke/dsh-reasoning-summary.
 *
 * The card uses the configuration page owned by DSH's plugins surface. Our
 * installed row's page is the `plugins.row.config` seat, dispatched by
 * `<package name>#<row id>` and registered only while the Host serves the
 * `reasoning-summary` namespace. The plugins page supplies the Host form —
 * the accepted values, the entry revision, and the revision-fenced write — and
 * draws the frame, the save control, and the failure notice itself, so this
 * component owns nothing but the catalog-driven route list. Changes are staged
 * locally and committed with a single revision-fenced `models` write.
 *
 * The route list follows the sibling cards of the same surface: rows are
 * checkbox-only, and routes that vanished from the catalog stay listed in a
 * trailing "saved but currently unavailable" group until Save removes them.
 */
// Browser halves are plain loader scripts and cannot import the host half, so
// both identity strings are literals here. `NS` must stay byte-identical to
// `SETTINGS_NAMESPACE` in src/index.ts: it keys the configuration document the
// host half reads, the locale namespace the seat translator is bound to, and the
// seat key `<package name>#<row id>` of our row's page. `PLUGIN_ID` must match
// the package name in package.json and the row id must match cordis.patch.yml.
// client.test.mjs asserts both spellings.
const NS = 'reasoning-summary';
const PLUGIN_ID = '@zhourenke/dsh-reasoning-summary';
window.__ModuleLoader__.load({
    id: PLUGIN_ID,
    factory: (require) => {
        const React = require('react');
        const e = React.createElement;
        const { useEffect, useMemo, useState } = React;
        const { SettingsForm } = require('@deepseek-ai/dsh-client-ui-primitives');
        const zh = {
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
            formUnavailable: '当前配置不可用。',
            save: '保存',
            saving: '保存中…',
            saveFailed: '保存失败，请重试。',
            catalogFailed: '模型目录加载失败；已保存的选择不会被自动删除。',
        };
        const en = {
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
            formUnavailable: 'This configuration is not available.',
            save: 'Save',
            saving: 'Saving…',
            saveFailed: 'Save failed; please try again.',
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
        function displayName(model) {
            return typeof model.name === 'string' && model.name !== model.id ? model.name : model.id;
        }
        function ModelRow(props) {
            const { item, providerName, modelName, available, checked, disabled, onToggle, t } = props;
            // The official `Checkbox` primitive renders its own visible label from a
            // `label` string, which would nest a second label inside this two-line
            // row; the sibling cards on this surface hand-roll the same bare input.
            return e('label', { className: 'rs-model' }, e('input', { type: 'checkbox', checked, disabled, onChange: onToggle }), e('span', null, e('span', { className: 'rs-model-name' }, modelName), e('span', { className: 'rs-route' }, `${providerName} · ${item.provider}/${item.model}`)), !available ? e('span', { className: 'rs-unavailable' }, t('unavailable')) : null);
        }
        /**
         * One row's configuration page. The plugins page renders this entry twice:
         * once as the row's one-liner (`view: 'summary'`, no form) and once, when the
         * row is opened, as the page body, where the owner supplies the Host form.
         * The page frame, its save control, and its failure notice are the official
         * settings form's; this component owns the catalog-driven route list only.
         */
        function SummaryCard(props) {
            // The seat supplies `props.t` because the registration declares
            // `locale: NS`; the renderer composes it as `localeSeat(face, NS)`. The
            // contract is `t(key, params?)`, and the host translator substitutes the
            // params it is given, so `{n}` is passed through rather than pre-rendered.
            const translate = props.t;
            const t = (key, ...args) => String(translate(key, args.length > 0 ? { n: args[0] } : undefined)).replace(/\{n\}/g, String(args[0] ?? 0));
            const form = props.form;
            const sessionFace = props.sessionFace;
            const [dirty, setDirty] = useState(false);
            const [saving, setSaving] = useState(false);
            const [failed, setFailed] = useState(false);
            const [draftModels, setDraftModels] = useState(() => copySelections(form?.state.value));
            const [catalog, setCatalog] = useState(null);
            const [catalogError, setCatalogError] = useState(null);
            // The plugins page mounts both views as separate entries, so every hook
            // runs in both and opening a row can never change the hook order.
            const isPage = props.view === 'page' && form !== undefined;
            const revision = form?.state.revision;
            const value = form?.state.value ?? { models: [] };
            useEffect(() => {
                if (!isPage || dirty)
                    return;
                setDraftModels(copySelections(form?.state.value));
                setFailed(false);
            }, [isPage, revision, dirty, value]);
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
            // Only the page body needs the catalog: the one-liner must stay a single
            // line of text and must not reach for the host on every list render.
            useEffect(() => { if (isPage)
                void loadCatalog(); }, [isPage]);
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
            // The summary entry is the row's one-liner; only the page entry has a form.
            if (props.view !== 'page')
                return e('span', null, t('description'));
            if (form === undefined || form.state.status !== 'ready')
                return null;
            // Candidate rows mirror the sibling cards on this surface exactly: a row
            // exists for every catalog model plus every saved route that is no longer
            // in the catalog (whether its provider survived or not). Unavailable routes
            // collect in a trailing group and keep their checkbox; unchecking one keeps
            // the row visible until Save commits the removal, so a vanished route is
            // never silently dropped.
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
            const writable = form.state.writable;
            const toggle = (item) => {
                const key = keyOf(item);
                setDraftModels((current) => current.some((entry) => keyOf(entry) === key)
                    ? current.filter((entry) => keyOf(entry) !== key)
                    : [...current, item]);
                setDirty(true);
            };
            const save = async () => {
                if (!writable || saving)
                    return;
                setSaving(true);
                setFailed(false);
                let accepted = false;
                try {
                    // One revision-fenced write for the whole list, fenced by the revision
                    // the drafts were staged against: a concurrent write elsewhere in the
                    // entry makes this fail rather than silently overwrite it.
                    accepted = await form.mutate([{ op: 'set', path: ['models'], value: draftModels }], revision);
                }
                catch {
                    accepted = false;
                }
                if (accepted)
                    setDirty(false);
                else
                    setFailed(true);
                setSaving(false);
            };
            const discard = () => {
                setDraftModels(copySelections(value));
                setDirty(false);
                setFailed(false);
            };
            const renderRow = (providerName, item, available, modelName) => e(ModelRow, {
                key: keyOf(item),
                item,
                providerName,
                modelName,
                available,
                checked: selected.has(keyOf(item)),
                disabled: !writable || saving,
                onToggle: () => toggle(item),
                t,
            });
            const controls = e('div', { className: 'rs-field' }, e('div', { className: 'rs-model-title' }, e('span', { className: 'rs-model-label' }, t('models')), e('span', { className: 'rs-count' }, t('selected', draftModels.length))), e('p', { className: 'rs-hint' }, t('modelsHint')), catalogError !== null ? e('div', { className: 'rs-catalog-error', role: 'alert' }, e('span', null, `${t('catalogFailed')} (${catalogError})`), e('button', { type: 'button', disabled: saving, onClick: () => { void loadCatalog(); } }, t('retry'))) : null, catalog === null && catalogError === null ? e('p', { className: 'rs-notice', role: 'status' }, t('loading')) : null, (catalog && catalog.length > 0) || effective.size > 0 ? e('fieldset', { className: 'rs-models' }, e('legend', null, t('models')), catalog?.map((group) => e('div', { className: 'rs-model-group', key: group.id }, e('div', { className: 'rs-provider' }, group.name ?? group.id), (group.models ?? []).map((model) => renderRow(group.name ?? group.id, { provider: group.id, model: model.id }, true, displayName(model))))), unavailable.length > 0 ? e('div', { className: 'rs-model-group' }, e('div', { className: 'rs-provider' }, t('unavailableGroup')), unavailable.map((item) => renderRow(item.provider, item, false, item.model))) : null) : null, catalog && catalog.length === 0 && effective.size === 0 ? e('p', { className: 'rs-notice' }, t('noModels')) : null);
            return e(SettingsForm, {
                labels: {
                    unavailable: t('formUnavailable'),
                    readOnly: t('readOnly'),
                    saveFailed: t('saveFailed'),
                    save: t('save'),
                    saving: t('saving'),
                },
                state: {
                    available: form.state.status === 'ready',
                    writable,
                    dirty,
                    invalid: false,
                    saving,
                    failed,
                },
                onSave: () => { void save(); },
                onDiscard: discard,
            }, controls);
        }
        // Only the field and route-list rules are ours: the page frame, the save
        // control, the failure notice, and the loading/read-only states belong to the
        // official settings form, so no card, header, footer, or button rule appears
        // here.
        const css = `
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
      .rs-model > input { margin: 0; }
      .rs-model-name, .rs-route { text-overflow: ellipsis; white-space: nowrap; display: block; overflow: hidden; }
      .rs-model-name { color: var(--dsw-alias-label-primary); font-size: 13px; }
      .rs-route { color: var(--dsw-alias-label-tertiary); margin-top: 2px; font-size: 11px; }
      .rs-unavailable { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
    `;
        function apply(ctx) {
            if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="reasoning-summary"]')) {
                const style = document.createElement('style');
                style.dataset.pluginCss = 'reasoning-summary';
                style.textContent = css;
                document.head.appendChild(style);
            }
            const slots = ctx.slots;
            const configForms = ctx.configForms;
            const locale = ctx.locale;
            if (!slots || !configForms || !locale)
                return;
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
            // The registration declares `locale: NS`, which is what puts the
            // translator on its props: the renderer reads the entry's `locale` and
            // composes `kit.t = localeSeat(face, ns)` for it (throwing when no locale
            // face is installed, so there is no "the seat might not supply it" case).
            // Binding our own translator here would shadow that identical prop.
            // Our row's configuration page: the plugins page dispatches
            // `plugins.row.config` by `<package name>#<row id>` and supplies the form,
            // so the page exists only while the Host serves this entry's namespace.
            ctx.effect(() => configForms.whileServed([NS], () => slots.inject('plugins.row.config', () => slots.register({
                name: 'plugins.row.config',
                key: `${PLUGIN_ID}#${NS}`,
                locale: NS,
            }, (props) => e(SummaryCard, { ...props, sessionFace })))), 'reasoning-summary: configuration page');
        }
        // `remote.session` gates activation on the namespace being mounted, so the
        // first catalog read cannot race the Host Remote assembly.
        return { apply, inject: ['slots', 'configForms', 'locale', 'remote', 'remote.session'] };
    },
});
