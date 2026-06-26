import { setup as setupWorlds } from "./local/worlds.js";
import { setup as setupGallery } from "./local/gallery.js";

export function setupWorldsAndGallery() {
    setupWorlds();
    setupGallery();
}