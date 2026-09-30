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
interface Window {
    __ModuleLoader__: {
        load(definition: {
            id: string;
            factory: (require: (id: string) => any) => any;
        }): void;
    };
}
declare const NS = "reasoning-summary";
declare const PLUGIN_ID = "@zhourenke/dsh-reasoning-summary";
