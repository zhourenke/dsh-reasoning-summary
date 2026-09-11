/**
 * Browser face for @zhourenke/dsh-reasoning-summary.
 *
 * The card deliberately uses the configurable-plugin slot owned by DSH's
 * official settings surface. It stages changes locally and writes only on
 * Save, while the model catalog is read live from the host API.
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
