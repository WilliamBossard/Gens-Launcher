export const SEND_CHANNELS = [
  "set-auto-download", "set-offline-mode", "download-update", "hide-window",
  "minimize-window", "show-window", "restore-main-window", "restart_app",
  "update-jump-list", "launch-game", "update-discord", "cancel-login-microsoft",
  "set-taskbar-progress", "overlay-ready", "quit-app", "confirm-update"
] as const;

export const INVOKE_CHANNELS = [
  "ping-server", "login-microsoft", "refresh-microsoft", "get-horizon-settings",
  "save-horizon-settings", "check-horizon-status", "call-horizon", "install-horizon",
  "check-java", "scan-java-versions", "fetch-curseforge", "fetch-mojang-profile",
  "fetch-mojang-raw-skin", "extract-tar", "get-still-running", "force-stop-game",
  "check-for-updates", "check-shortcut-exists", "delete-desktop-shortcut",
  "create-desktop-shortcut", "compress-folder", "read-zip-text", "extract-zip",
  "search-modrinth", "upload-mojang-skin", "reconnect-discord", "download-file-stream",
  "copy-image-to-sandbox", "copy-file-to-sandbox", "delete-msa-cache", "hash-file",
  "check-internet", "do-deb-update", "run-forge-installer", "duplicate-instance-folder",
  "fs:readFile", "fs:writeFile", "fs:readdir", "fs:stat", "fs:mkdir", "fs:rm",
  "fs:unlink", "fs:rename", "fs:cp", "fs:copyFile", "fs:chmod", "fs:appendFile",
  "fs:access", "fs:exists", "system:open-external", "system:open-path",
  "system:show-item-in-folder", "system:clipboard-write-text", "hash-buffer",
  "nbt:parse", "nbt:write"
] as const;

export const RECEIVE_CHANNELS = [
  "trigger-auto-launch", "update-msg", "update-available-prompt", "update-progress",
  "update-downloaded", "microsoft-device-code", "mc-progress", "mc-data",
  "mc-started", "mc-close", "horizon-status", "zip-progress", "launch-game-rejected",
  "horizon-install-progress"
] as const;

export type SendChannel = (typeof SEND_CHANNELS)[number];
export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type ReceiveChannel = (typeof RECEIVE_CHANNELS)[number];

export type Unsubscribe = () => void;

export interface UpdateMsgEvent {
  key?: string;
  text?: string;
  type?: string;
  [key: string]: unknown;
}

export interface LaunchGameRejectedEvent {
  instanceId: string;
  reason: "ALREADY_RUNNING" | string;
  [key: string]: unknown;
}

export interface McProgressEvent {
  instanceId: string;
  task?: number;
  total?: number;
  type?: string;
  [key: string]: unknown;
}

export interface McDataEvent {
  instanceId: string;
  data: string;
}

export interface McStartedEvent {
  instanceId: string;
}

export interface McCloseEvent {
  instanceId: string;
  code: number;
}

export interface HorizonStatusEvent {
  type?: "PROGRESS" | "INFO" | "SUCCESS" | "ERROR" | "ROLLBACK_LIST" | "CHECK_RESULT" | "CLOUD_LIST" | "OFFLINE" | string;
  step?: string;
  value?: number;
  instance?: string;
  message?: string;
  errorCode?: string;
  data?: unknown;
  richData?: unknown;
  delta?: string;
  [key: string]: unknown;
}

export interface HorizonEngineStatus {
  installed: boolean;
  localVersion: string;
  latestVersion: string | null;
  needsUpdate: boolean;
  linked: boolean;
  provider: string;
  offline?: boolean;
}

export interface HorizonSettings {
  systemEnabled?: boolean;
  syncMode?: string;
  autoSync?: boolean;
  autoUpload?: boolean;
  provider?: string;
  maxRetries?: number;
  retryBaseDelay?: number;
  deltaCleanupThreshold?: number;
  [key: string]: unknown;
}

export interface OperationResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface InvokeArgByChannel {
  "call-horizon": string | string[];
  "save-horizon-settings": HorizonSettings;
  "check-horizon-status": boolean;
}

export interface InvokeResultByChannel {
  "check-horizon-status": HorizonEngineStatus;
  "get-horizon-settings": HorizonSettings;
  "save-horizon-settings": OperationResult;
  "install-horizon": OperationResult & { version?: string };
  "call-horizon": unknown;
  "check-internet": boolean;
}

export interface ReceivePayloadByChannel {
  "trigger-auto-launch": string;
  "update-msg": UpdateMsgEvent;
  "update-available-prompt": Record<string, unknown>;
  "update-progress": number;
  "update-downloaded": unknown;
  "microsoft-device-code": Record<string, unknown>;
  "mc-progress": McProgressEvent;
  "mc-data": McDataEvent;
  "mc-started": McStartedEvent;
  "mc-close": McCloseEvent;
  "horizon-status": HorizonStatusEvent;
  "zip-progress": Record<string, unknown>;
  "launch-game-rejected": LaunchGameRejectedEvent;
  "horizon-install-progress": number;
}

export interface ApiFsStat {
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtime: string | number | Date;
  mtimeMs: number;
  birthtime: string | number | Date;
}

export interface GensLauncherApi {
  send: (channel: SendChannel, data?: unknown) => void;
  invoke: <C extends InvokeChannel>(
    channel: C,
    data?: C extends keyof InvokeArgByChannel ? InvokeArgByChannel[C] : unknown
  ) => Promise<C extends keyof InvokeResultByChannel ? InvokeResultByChannel[C] : unknown>;
  on: <C extends ReceiveChannel>(channel: C, func: (payload: ReceivePayloadByChannel[C]) => void) => Unsubscribe | undefined;

  nbt: {
    parse: (arr: ArrayBuffer | Uint8Array | number[]) => Promise<unknown>;
    write: (data: unknown) => Uint8Array;
  };

  security: {
    writeJSON: (filePath: string, data: unknown) => Promise<void>;
    readJSON: (filePath: string) => Promise<unknown>;
    writeJSONAsync: (filePath: string, data: unknown) => Promise<void>;
    readJSONAsync: (filePath: string) => Promise<unknown>;
  };

  tools: {
    hashFile: (filePath: string, algo: "sha1" | "sha256" | "sha512" | "md5") => Promise<string>;
    hashBuffer: (arr: ArrayBuffer | Uint8Array | number[], algo: "sha1" | "sha256" | "sha512" | "md5") => Promise<string>;
    extractTar: (archivePath: string, destDir: string) => Promise<unknown>;
  };

  path: {
    join: (...args: string[]) => string;
    resolve: (...args: string[]) => string;
    extname: (p: string) => string;
    dirname: (p: string) => string;
    basename: (p: string, ext?: string) => string;
  };

  fs: {
    promises: {
      readFile: (p: string, enc?: BufferEncoding) => Promise<unknown>;
      readdir: (p: string) => Promise<string[]>;
      stat: (p: string) => Promise<ApiFsStat>;
      writeFile: (p: string, d: unknown, enc?: BufferEncoding) => Promise<unknown>;
      rm: (p: string, opts?: unknown) => Promise<unknown>;
      cp: (src: string, dest: string, opts?: unknown) => Promise<unknown>;
      unlink: (p: string) => Promise<unknown>;
      chmod: (p: string, mode: unknown) => Promise<unknown>;
      mkdir: (p: string, opts?: unknown) => Promise<unknown>;
      rename: (oldPath: string, newPath: string) => Promise<unknown>;
      appendFile: (p: string, d: unknown, enc?: BufferEncoding) => Promise<unknown>;
      access: (p: string, mode?: number) => Promise<unknown>;
      copyFile: (src: string, dest: string) => Promise<unknown>;
      exists: (p: string) => Promise<boolean>;
    };
  };

  os: {
    totalmem: () => number;
    freemem: () => number;
    cpus: () => unknown[];
    hostname: () => string;
    userInfo: () => { username: string; homedir: string };
  };

  shell: {
    openExternal: (url: string) => Promise<unknown>;
    openPath: (p: string) => Promise<unknown>;
    showItemInFolder: (p: string) => Promise<unknown>;
  };

  clipboard: {
    writeText: (text: string) => Promise<unknown>;
  };

  appData: string;
  platform: string;
  arch: string;
  version: string;
  isAutoLaunch: boolean;
  isAppImage: boolean;

  getFilePath: (file: File) => string;
  copyImageToSandbox: (srcPath: string, destName: string, subDir?: string) => Promise<unknown>;
  copyFileToSandbox: (srcPath: string, destName: string) => Promise<unknown>;
}
