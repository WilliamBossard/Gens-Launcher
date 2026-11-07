import type { App, BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent, Shell } from "electron";
import type * as Path from "path";
import type * as Fs from "fs";
import type * as Os from "os";
import type * as Crypto from "crypto";
import type { execFile, spawn } from "child_process";
import type { AppUpdater } from "electron-updater";

/**
 * Contexte applicatif partagé injecté dans chaque sous-module IPC de `src/main/`.
 * Permet de découpler `main.js` et de typer strictement les dépendances du Main Process.
 */
export interface MainContext {
  app: App;
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null | undefined;
  safeDataDir: string;
  mainLog: (msg: string) => void;
  path: typeof Path;
  fs: typeof Fs;
  os: typeof Os;
  crypto: typeof Crypto;
  execFile: typeof execFile;
  spawn: typeof spawn;
  autoUpdater: AppUpdater;
  horizonBinDir: string;
  horizonExePath: string;
  horizonVersionPath: string;
  isWin: boolean;
  safeSend: (event: IpcMainEvent | IpcMainInvokeEvent | { sender: any } | null | undefined, channel: string, payload?: unknown) => void;
  mainSafeDir: (name: string) => string;
  mainResolveInstanceFolder: (nameOrFolder: string) => string;
  assertPathUnderSandbox: (p: string) => string;
  sanitizeShortcutName: (name: string) => string;
  shell: Shell;
}

