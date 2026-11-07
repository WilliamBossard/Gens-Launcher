import type { OpenString } from "./ipc";

export type MinecraftLoader = OpenString<"vanilla" | "forge" | "fabric" | "quilt" | "neoforge">;

export interface ServerEntry {
  name: string;
  ip: string;
  icon?: string;
  ping?: number;
  online?: boolean;
  players?: {
    max: number;
    online: number;
  };
  version?: string;
  motd?: string;
}

export interface MinecraftInstance {
  name: string;
  version: string;
  loader: MinecraftLoader;
  loaderVersion?: string;
  ram?: number | string;
  javaPath?: string;
  javaVersion?: number | string;
  jvmArgs?: string;
  jvmProfile?: string;
  resW?: number | string;
  resH?: number | string;
  notes?: string;
  group?: string;
  backupMode?: string;
  backupLimit?: number;
  disableHorizon?: boolean;
  modrinthId?: string;
  curseforgeId?: number | string;
  servers?: Array<ServerEntry | string | any>;
  icon?: string;
  playTime?: number;
  launchCount?: number;
  lastPlayed?: number | string;
  created?: number;
  sessionHistory?: Array<{ date: string; ms: number }>;
  _tempSessionStart?: number | null;
  _localConfigUpdatedAt?: number;
  _cloudExportedAt?: number;
  gameRunning?: boolean;
  autoConnect?: string | null;
  modpackVersion?: string;
  [key: string]: unknown;
}

export interface OfflineAccount {
  type: "offline";
  name: string;
  uuid: string;
  skin?: string;
  skinBase64?: string;
  [key: string]: unknown;
}

export interface MicrosoftAccount {
  type: "microsoft";
  name: string;
  uuid: string;
  mclcAuth: any;
  skin?: string;
  skinBase64?: string;
  [key: string]: unknown;
}

export type MinecraftAccount = OfflineAccount | MicrosoftAccount;

export interface ThemeSettings {
  accent: string;
  bg: string;
  dim: number;
  blur: number;
  panelOpacity: number;
}

export interface GlobalSettings {
  defaultRam: number;
  unlockedAchievements: string[];
  defaultJavaPath: string;
  cfApiKey: string;
  serverIp: string;
  language: string | null;
  theme: ThemeSettings;
  launcherVisibility: string;
  newsCollapsed: boolean;
  enableNewsBanner: boolean;
  disableRPC: boolean;
  offlineMode: boolean;
  multiInstance: boolean;
  autoDownloadUpdates: boolean;
  totalInstancesCreated: number;
  collapsedGroups: Record<string, boolean>;
  disableAnimations: boolean;
  disableTransparency: boolean;
  defaultOptionsInstance: string | null;
  defaultServersInstance: string | null;
}

export interface LauncherStore {
  dataDir: string;
  instancesRoot: string;
  langDir: string;
  logsDir: string;
  instanceFile: string;
  accountFile: string;
  settingsFile: string;
  allInstances: MinecraftInstance[];
  allAccounts: MinecraftAccount[];
  rawVersions: any[];
  globalSettings: GlobalSettings;
  currentLangObj: Record<string, string>;
  selectedInstanceIdx: number | null;
  selectedAccountIdx: number | null;
  uiSelectedAccRow: any;
  isGameRunning: boolean;
  activeInstances: Set<any>;
  sessionStartTime: number;
  maxSafeRam: number;
  pendingIconPath: string | null;
  primaryRpcInstance: string | null;
  pendingLauncherUpdate: any;
  horizonActive: boolean;
  cloudTarget: string | null;
  cloudTargetSlug: string | null;
  _diskSizeCache: { value: string; ts: number } | null;
  [key: string]: any;
}
