import type { GensLauncherApi } from "./ipc";

declare global {
  interface Window {
    api: GensLauncherApi;
  }
}

export {};
