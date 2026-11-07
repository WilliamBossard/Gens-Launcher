// Keep these channel lists in sync with preload.js (vérifié par tests/ipc-channels.test.js).
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

/**
 * Union de littéraux qui reste ouverte à d'autres chaînes SANS perdre l'autocomplétion.
 * (`"A" | string` s'effondre en `string`, alors que `"A" | (string & {})` garde les suggestions.)
 */
export type OpenString<T extends string> = T | (string & {});

export type ToastType = "info" | "success" | "error" | "warning";

export interface UpdateMsgEvent {
  key?: string;
  text?: string;
  type?: ToastType;
}

export interface LaunchGameRejectedEvent {
  instanceId: string;
  reason: OpenString<"ALREADY_RUNNING">;
}

/** Les champs proviennent de gens-core (`{ instanceId, ...e }`) : contenu volontairement ouvert. */
export interface McProgressEvent {
  instanceId: string;
  task?: any;
  total?: any;
  type?: string;
  [key: string]: any;
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

// ─────────────────────────────────────────────────────────────────────────────
// Protocole Horizon (stdout JSON, une ligne = un message)
// Source de vérité côté launcher : sert aussi de cahier des charges pour un
// éventuel portage d'Horizon (ex. Go). Toute évolution d'Horizon doit être
// reflétée ici.
// ─────────────────────────────────────────────────────────────────────────────

export type HorizonProgressStep =
  | "CHECKING"
  | "DOWNLOADING"
  | "VERIFYING"
  | "EXTRACTING"
  | "APPLYING_DELTA"
  | "COMPRESSING"
  | "UPLOADING";

export type HorizonErrorCode = "ERR_ALREADY_RUNNING" | "AUTH_EXPIRED" | "NOT_ON_CLOUD";

export type HorizonUploadMode = "FULL" | "SMART" | "REPACK";

/** Progression d'une opération (sync.js / upload.js). `value` est un pourcentage 0-100. */
export interface HorizonProgressMessage {
  type: "PROGRESS";
  step: HorizonProgressStep;
  value: number;
  instance: string;
  /** Nom du fichier delta en cours (étape APPLYING_DELTA uniquement). */
  delta?: string;
}

export interface HorizonInfoMessage {
  type: "INFO";
  message: string;
  instance?: string;
}

/**
 * Succès. Champs selon la commande :
 * - upload : `mode` (+ `summary` en SMART), pas de `message`
 * - sync   : `base`, `deltas`, `message`
 * - rollback / login / delete : `message`
 */
export interface HorizonSuccessMessage {
  type: "SUCCESS";
  instance?: string;
  message?: string;
  mode?: HorizonUploadMode;
  summary?: string;
  base?: boolean;
  deltas?: number;
}

export interface HorizonErrorMessage {
  type: "ERROR";
  message: string;
  instance?: string;
  errorCode?: OpenString<HorizonErrorCode>;
  /** true si un dossier `_rollback_` est disponible pour restaurer l'instance. */
  hasRollback?: boolean;
  status?: "ERROR";
}

export interface HorizonOfflineMessage {
  type: "OFFLINE";
  message: string;
  status?: "OFFLINE";
}

export interface HorizonCheckResultMessage {
  type: "CHECK_RESULT";
  status: "UP_TO_DATE" | "UPDATE_AVAILABLE" | "NOT_LOGGED_IN";
  /** Noms (canoniques) des instances ayant une version plus récente sur le Cloud. */
  updates: string[];
  message?: string;
}

export interface HorizonCloudInstance {
  /** Nom canonique (safeDir) utilisé sur le Cloud. */
  name: string;
  realName: string;
  deltaCount: number;
  sizeBytes: number;
  /** Date ISO du backup de base. */
  lastBackup: string | null;
  /** Data-URL de l'icône, si connue. */
  iconData: string | null;
  loader: string | null;
}

export interface HorizonCloudListMessage {
  type: "CLOUD_LIST";
  /** Noms canoniques des instances présentes sur le Cloud. */
  data: string[];
  richData: HorizonCloudInstance[];
}

export interface HorizonQuotaInstance {
  name: string;
  bytes: number;
  deltaCount: number;
}

export interface HorizonQuotaMessage {
  type: "QUOTA";
  provider: string;
  /** 0 = illimité / inconnu. */
  totalBytes: number;
  usedBytes: number;
  horizonBytes: number;
  instances: HorizonQuotaInstance[];
}

export interface HorizonRollbackEntry {
  folder: string;
  instance: string;
  /** Date ISO, ou null si le timestamp du dossier est illisible. */
  timestamp: string | null;
}

export interface HorizonRollbackListMessage {
  type: "ROLLBACK_LIST";
  data: HorizonRollbackEntry[];
}

export interface HorizonLogMessage {
  type: "LOG";
  level?: OpenString<"INFO" | "WARN" | "ERROR">;
  message: string;
}

export interface HorizonCleanItem {
  id: string;
  name: string;
  size: number;
  reason: string;
}

export interface HorizonCleanPreviewMessage {
  type: "CLEAN_PREVIEW";
  count: number;
  freedBytes: number;
  freedFormatted: string;
  items: HorizonCleanItem[];
}

export interface HorizonCleanCompleteMessage {
  type: "CLEAN_COMPLETE";
  count: number;
  freedBytes: number;
  freedFormatted: string;
  items: HorizonCleanItem[];
  message: string;
}

/** Union discriminée par `type` : `if (msg.type === "QUOTA") msg.totalBytes` est typé. */
export type HorizonStatusEvent =
  | HorizonProgressMessage
  | HorizonInfoMessage
  | HorizonSuccessMessage
  | HorizonErrorMessage
  | HorizonOfflineMessage
  | HorizonCheckResultMessage
  | HorizonCloudListMessage
  | HorizonQuotaMessage
  | HorizonRollbackListMessage
  | HorizonCleanPreviewMessage
  | HorizonCleanCompleteMessage
  | HorizonLogMessage;

export type HorizonMessageType = HorizonStatusEvent["type"];

/** Résultat de `invoke("call-horizon", ...)` (voir runHorizonAction dans ipc-horizon.js). */
export interface HorizonCallResult {
  /** Code de sortie du processus, -1 si annulé / refusé / tué. */
  exitCode: number;
  /** Dernier message JSON reçu sur stdout. */
  lastJson: HorizonStatusEvent | null;
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

/** Clés acceptées par `save-horizon-settings` (ALLOWED_KEYS dans ipc-horizon.js). */
export interface HorizonSettings {
  systemEnabled?: boolean | string;
  syncMode?: "SMART" | "FULL" | string;
  autoSync?: boolean | string;
  autoUpload?: boolean | string;
  provider?: OpenString<"google" | "dropbox" | "onedrive">;
  maxRetries?: number;
  retryBaseDelay?: number;
  deltaCleanupThreshold?: number;
  [key: string]: any;
}

export interface OperationResult {
  success: boolean;
  error?: string;
}

export interface InvokeArgByChannel {
  "call-horizon": string | string[];
  "save-horizon-settings": HorizonSettings;
  "check-horizon-status": boolean;
  "hash-file": { filePath: string; algo: "sha1" | "sha256" | "sha512" | "md5" };
}

export interface InvokeResultByChannel {
  "check-horizon-status": HorizonEngineStatus;
  "get-horizon-settings": HorizonSettings;
  "save-horizon-settings": OperationResult;
  "install-horizon": OperationResult & { version?: string };
  "call-horizon": HorizonCallResult;
  "check-internet": boolean;
  "hash-file": OperationResult & { hash?: string };
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
  isDirectory: any;
  isFile: any;
  size: number;
  mtime: any;
  mtimeMs: number;
  birthtime: any;
}

export interface GensLauncherApi {
  send: (channel: SendChannel, data?: any) => void;
  invoke: <C extends InvokeChannel>(
    channel: C,
    data?: C extends keyof InvokeArgByChannel ? InvokeArgByChannel[C] : any
  ) => Promise<C extends keyof InvokeResultByChannel ? InvokeResultByChannel[C] : any>;
  on: <C extends ReceiveChannel>(channel: C, func: (payload: ReceivePayloadByChannel[C]) => void) => Unsubscribe | undefined;

  nbt: {
    parse: (arr: ArrayBuffer | Uint8Array | number[]) => Promise<any>;
    write: (data: any) => Uint8Array;
  };

  security: {
    writeJSON: (filePath: string, data: any) => Promise<void>;
    readJSON: (filePath: string) => Promise<any>;
    writeJSONAsync: (filePath: string, data: any) => Promise<void>;
    readJSONAsync: (filePath: string) => Promise<any>;
  };

  tools: {
    hashFile: (filePath: string, algo: "sha1" | "sha256" | "sha512" | "md5") => Promise<string>;
    hashBuffer: (arr: ArrayBuffer | Uint8Array | number[], algo: "sha1" | "sha256" | "sha512" | "md5") => Promise<string>;
    extractTar: (archivePath: string, destDir: string) => Promise<any>;
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
      readFile: (p: string, enc?: BufferEncoding | string) => Promise<any>;
      readdir: (p: string) => Promise<string[]>;
      stat: (p: string) => Promise<ApiFsStat>;
      writeFile: (p: string, d: any, enc?: BufferEncoding | string) => Promise<void>;
      rm: (p: string, opts?: any) => Promise<void>;
      cp: (src: string, dest: string, opts?: any) => Promise<void>;
      unlink: (p: string) => Promise<void>;
      chmod: (p: string, mode: any) => Promise<void>;
      mkdir: (p: string, opts?: any) => Promise<void>;
      rename: (oldPath: string, newPath: string) => Promise<void>;
      appendFile: (p: string, d: any, enc?: BufferEncoding | string) => Promise<void>;
      access: (p: string, mode?: number) => Promise<void>;
      copyFile: (src: string, dest: string) => Promise<void>;
      exists: (p: string) => Promise<boolean>;
    };
  };

  os: {
    totalmem: () => number;
    freemem: () => number;
    cpus: () => any[];
    hostname: () => string;
    userInfo: () => { username: string; homedir: string };
  };

  shell: {
    openExternal: (url: string) => Promise<any>;
    openPath: (p: string) => Promise<any>;
    showItemInFolder: (p: string) => Promise<any>;
  };

  clipboard: {
    writeText: (text: string) => Promise<any>;
  };

  appData: string;
  platform: string;
  arch: string;
  version: string;
  isAutoLaunch: boolean;
  isAppImage: boolean;

  getFilePath: (file: File) => string;
  copyImageToSandbox: (srcPath: string, destName: string, subDir?: string) => Promise<any>;
  copyFileToSandbox: (srcPath: string, destName: string) => Promise<any>;
}
