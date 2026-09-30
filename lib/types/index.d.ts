/**
 * @zhourenke/dsh-reasoning-summary
 *
 * Phase-one action-summary relay for DeepSeek Harness. The host half owns the
 * durable model selection and intercepts the canonical LLM stream. The
 * canonical summaries are durable relay history: continuing relays enter the
 * next step, while tool-turn final relays remain visible in all later model
 * contexts so a model switch preserves the full action trail.
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
export declare const name = "reasoning-summary";
/**
 * Declare this producer's own message source. DSH has no shared catch-all
 * `plugin` kind: `MessageSourceMap` is merge-extensible and every producer
 * declares its own term in its own module, which is also what makes
 * `source.kind` a reliable statement of *who wrote this*. `ContextFormed` mixes
 * in the optional `form` vocabulary, so the relay and notice forms below stay
 * type-checked against their required fields.
 */
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'reasoning-summary': {
            kind: 'reasoning-summary';
        } & ContextFormed;
    }
}
/**
 * The row's configuration namespace, and one of the three consumers of the same
 * id: the profile patch entry's `id`, the namespace the client reads through
 * `ctx.configForms`, and the `<row id>` half of the `plugins.row.config` key.
 * It must match the `id` in `cordis.patch.yml` character for character; a
 * mismatch leaves the page's form permanently absent, with only a warning.
 */
export declare const SETTINGS_NAMESPACE = "reasoning-summary";
export interface ModelSelection {
    provider: string;
    model: string;
}
export interface ReasoningSummaryConfig {
    /** Exact provider/model routes for which this feature is active. */
    models: ModelSelection[];
}
/**
 * The profile entry's configuration as the loader hands it over: `models` is
 * volatile, so it arrives as a box whose `get()` answers the current value
 * rather than the array frozen at activation.
 */
export interface PluginConfig {
    models: Volatile<ModelSelection[]>;
}
/**
 * The row's configuration, limited to model routes. `models` carries the
 * volatile marker, and that marker is what keeps the value live for the running
 * plugin. It lands on the field's own ref (`meta.volatile`), so the schema has
 * to stay a plain object: wrapping it in `z.transform` or `.default()` moves the
 * marker onto the wrapper and the loader would then freeze the value at apply
 * time, leaving a saved setting invisible until the next restart.
 */
export declare const Config: ReturnType<typeof z.any>;
declare const MISSING_TEXT = "Missing action summary: no <summary> tag was received in visible text \u2014 reasoning/thinking content is never read, and text outside the tag is discarded. Before your next tool call, emit the summary as visible assistant text in a literal <summary>...</summary> tag.";
declare const PARTIAL_TEXT = "Summary incomplete: the response ended before the closing tag; only a fully closed tag counts as a summary.";
interface SummaryInfo {
    status: 'complete' | 'partial' | 'missing';
    content: string;
}
declare function routeKey(provider: unknown, model: unknown): string;
/**
 * Read the first nearest-neighbor summary pair from one text block. A stray
 * opening tag cannot claim a later pair when another opening tag appears
 * first; the nearest complete pair is authoritative. If no pair closes, the
 * last opening tag remains eligible for the existing partial-stream behavior.
 */
declare function inspectSummary(text: string): {
    start: number;
    end: number;
    info: 'complete' | 'partial';
    content: string;
} | undefined;
/**
 * Normalize model-emitted summary markup in pure text-block form. The
 * authoritative input tag is removed from the returned block and represented
 * by a compact action-summary relay; direct callers retain later literal tags.
 * Tool-step finalization applies the stronger UI policy by hiding every text
 * block; only an explicit tag may supply relay content.
 */
declare function normalizeTextBlocks(texts: readonly string[], required: boolean, forcedStatus?: 'partial'): {
    texts: string[];
    summary?: SummaryInfo;
};
export declare const inject: string[];
export declare function apply(ctx: Context, config: PluginConfig): void;
export { MISSING_TEXT, PARTIAL_TEXT, inspectSummary, normalizeTextBlocks, routeKey, };
