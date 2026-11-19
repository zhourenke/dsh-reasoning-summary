/**
 * Browser face for @zhourenke/dsh-reasoning-summary.
 *
 * The card uses the configuration page owned by DSH's plugins surface. Our
 * installed row's page is the `plugins.row.config` seat, dispatched by
 * `<package name>#<row id>` and registered only while the Host serves the
 * `reasoning-summary` namespace. The plugins page draws the row, the page
 * header, and the crumb; this entry owns its body and its own save control,
 * because DSH 0.2.2 no longer ships the shared `SettingsForm` primitive that
 * used to draw that frame. Changes are staged locally and committed with a
 * single revision-fenced `models` write.
 *
 * The form's availability states follow the Host snapshot's `status`: a
 * `loading` form renders nothing so the unavailable notice cannot flash while
 * the describe read is in flight, and an `unavailable` one renders that notice
 * here.
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
