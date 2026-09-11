/**
 * @zhourenke/dsh-reasoning-summary
 *
 * Phase-one action-summary relay for DeepSeek Harness. The host half owns the
 * durable model selection and intercepts the canonical LLM stream. The
 * canonical summaries are durable relay history: continuing relays enter the
 * next step, while tool-turn final relays remain visible in all later model
 * contexts so a model switch preserves the full action trail.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "reasoning-summary";
/**
 * Settings namespace owned by this plugin. DSH validates the plain lowercase
 * form against `/^[a-z][a-z0-9-]*$/`, which this literal satisfies, so no
 * branding helper is involved: `settingsNamespace()` was removed from
 * `@deepseek-ai/dsh-settings` after 0.1.1-rc.2 and importing it would make the
 * plugin depend on a private copy of the host package.
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
export declare const Config: ReturnType<typeof z.any>;
declare const MISSING_TEXT = "Summary unavailable: the model did not provide a complete summary.";
declare const PARTIAL_TEXT = "Summary incomplete: the response ended before the closing tag.";
interface SummaryInfo {
    status: 'complete' | 'partial' | 'missing' | 'inferred';
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
declare function normalizeSummaryContent(content: string, status: 'complete' | 'partial' | 'missing' | 'inferred'): string;
/**
 * Normalize model-emitted summary markup in pure text-block form. The
 * authoritative input tag is removed from the returned block and represented
 * by a compact action-summary relay; direct callers retain later literal tags.
 * Tool-step finalization applies the stronger UI policy by hiding every text
 * block and stripping later tags from inferred relay details.
 *
 * `turn` and `step` remain part of the exported helper's established call
 * shape, although provenance no longer repeats those coordinates in text.
 */
declare function normalizeTextBlocks(texts: readonly string[], required: boolean, _turn: number, _step: number, forcedStatus?: 'partial'): {
    texts: string[];
    summary?: SummaryInfo;
};
export declare const inject: string[];
export declare function apply(ctx: Context): void;
export { MISSING_TEXT, PARTIAL_TEXT, inspectSummary, normalizeSummaryContent, normalizeTextBlocks, routeKey, };
