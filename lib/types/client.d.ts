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
        load(definition: {
            id: string;
            factory: (require: (id: string) => any) => any;
        }): void;
    };
}
declare const NS = "reasoning-summary";
declare const PLUGIN_ID = "@zhourenke/dsh-reasoning-summary";
