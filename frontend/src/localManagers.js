// @ts-check
import { setup as setupMods } from "./local/mods.js";
import { setup as setupShaders } from "./local/shaders.js";
import { setup as setupResourcePacks } from "./local/resourcepacks.js";
import { setup as setupServers } from "./local/servers.js";
import { setup as setupInstallers } from "./local/installers.js";
import { setup as setupDatapacks } from "./local/datapacks.js";

export function setupLocalManagers() {
    setupMods();
    setupShaders();
    setupResourcePacks();
    setupServers();
    setupInstallers();
    setupDatapacks();
}
