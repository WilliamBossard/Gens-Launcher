import type { GensLauncherApi, ToastType } from "./ipc";
import type { MinecraftInstance, MinecraftAccount } from "./models";

declare global {
  // Global functions accessible directly or via window
  function t(key: string, fallback?: string): string;
  function escapeHTML(str: unknown): string;
  function sanitizeHTML(str: string): string;

  interface Window {
    api: GensLauncherApi;

    // ── Flags & Internal State ──
    isTrulyOnline: boolean;
    _isAutoLaunch?: boolean;
    _isAppImage?: boolean;
    _isStorageLoaded?: boolean;
    _isManualHorizon?: boolean;
    _isInternalDrag?: boolean;
    _msLoginSessionActive?: boolean;
    _currentCrashLog?: string | null;
    _gameLogFiles?: Record<string, string>;
    _lastCloudGridHtml?: string;
    _lastQuotaHtml?: string;
    _cloudInstances?: string[];
    _cloudRichData?: any[];
    _pendingAutoLaunch?: any;
    _serverStatusInterval?: any;
    lastLoadedSkinUrl?: string | null;
    ctxTargetIdx?: any;
    ACHIEVEMENTS?: Record<string, any>;
    activeModal?: any;

    // ── src/utils.js & Helpers ──
    t: (key: string, fallback?: string) => string;
    showToast: (msg?: any, type?: any) => void;
    showCustomConfirm: (msg: string, isDestructive?: boolean) => Promise<boolean>;
    showLoading: (text?: string, percent?: number | null) => void;
    updateLoadingPercent: (percent: number | null, text?: string | null) => void;
    hideLoading: () => void;
    escapeHTML: (str: unknown) => string;
    sanitizeHTML: (str: string) => string;
    safeDir: (name: string, ...args: any[]) => string;
    sameFolderSlug: (a: string, b: string) => boolean;
    sameFsPath: (a: string, b: string) => boolean;
    resolveInstanceFolder: (name: string) => string;
    resolveInstanceName: (name: string) => string;
    existsSafe: (p: string) => Promise<boolean>;
    enforceReadSandbox?: (p: string, isRead?: boolean) => string;
    safeWriteJSONAsync: (p: string, data: any) => Promise<any>;
    safeWriteJSON: (p: string, data: any) => Promise<any>;
    safeUnlink: (p: string) => Promise<void>;
    safeRm: (p: string, options?: any) => Promise<void>;
    copyToClipboard: (text: string) => Promise<boolean>;
    closeModal: (id?: string) => void;
    openModal?: (modalId: string) => void;
    showJavaTypeModal: (version: string | number, t?: (k: string, f?: string) => string) => Promise<"jre" | "jdk" | null>;
    checkAchievement: (id: string) => void;
    checkOffline: (e?: any) => boolean;
    openDir: (subDir: string) => Promise<void>;
    openSystemPath: (p: string) => void | Promise<any>;

    // ── UI Managers & Rendering ──
    renderUI: (skipStats?: boolean, ...args: any[]) => void;
    renderAccountManager: () => void;
    updateAccountDropdown: () => void;
    updateNetworkUI: () => void;
    updateOfflineUIState: () => void;
    setUIState: (state?: string) => void;
    switchTab: (tabId: string) => void;
    switchTabGlob: (tabId: string) => void;
    appendLog: (msg: string, type?: string) => void;
    copyLogs: () => void;
    copyCrashLog: () => void;
    analyzeCrash: (instanceName: string, exitCode?: number | null) => Promise<any>;
    openLastCrashReport: () => void;
    applyTranslations: () => void;
    populateLangDropdown: () => void;
    loadLanguage: (lang: string) => Promise<void>;
    changeLanguage: (lang: string) => Promise<void>;
    applyTheme: () => void;
    loadNews: (force?: boolean) => Promise<void>;
    toggleNews: () => void;
    saveFirstLaunch: () => Promise<void>;
    openStatsModal: () => void;
    closeStatsModal: () => void;
    checkRealInternet: () => Promise<void>;

    // ── Instances & Launch ──
    openInstanceModal: () => void;
    closeInstanceModal: () => void;
    saveInstance: () => Promise<void>;
    selectInstance: (idx: number) => void;
    handleInstanceDoubleClick: (idx: number) => void;
    deleteInstance: (idx?: number) => Promise<void>;
    copyInstance: (idx?: number) => Promise<void>;
    exportInstance: () => void | Promise<void>;
    cleanCache: () => Promise<void>;
    openEditModal: (tab?: string) => Promise<void>;
    closeEditModal: () => void;
    saveEdit: () => Promise<void>;
    updateEditLoaderVersions: () => Promise<void>;
    toggleEditSnapshots: () => void;
    updateLoaderVersions: () => Promise<void>;
    updateVersionList: (showSnapshots: boolean) => void;
    scheduleSearch: () => void;
    openContextMenu: (e: any, idx?: any, ...args: any[]) => void;
    dragInstanceStart: (e: any, idx?: any) => void;
    dropInstanceOnGroup: (e: any, groupName?: any) => void;
    toggleCategory: (groupName?: any, ...args: any[]) => void;
    instanceNameTaken: (name: string, excludeIdx?: number) => boolean;
    nextAvailableInstanceName: (baseName: string) => string;
    previewInstanceIcon: (target: any) => void | Promise<void>;
    openIconGallery: () => void;
    selectGalleryIcon: (iconName: string) => void;
    updateIconCache?: (inst: any) => Promise<void>;
    updateLaunchButton: (status?: string) => void;
    updateJvmDesc: () => void;
    updateJavaButtonsDisplay: () => void;
    restoreRunningInstances: () => Promise<void>;
    processAutoLaunch: (arg?: any) => void | Promise<void>;
    abortAutoLaunch: () => void;
    cancelAutoLaunch: () => void;
    setAutoConnect: (server: any) => void;
    saveDefaultOptions: () => Promise<void>;
    forceInjectOptions: () => Promise<void>;
    saveDefaultServers: () => Promise<void>;
    mergeInstanceConfigFromDisk: (safeName?: string | null) => Promise<boolean>;
    writeInstanceMetaForCloud: (inst: MinecraftInstance | any, opts?: any) => Promise<void>;

    // ── Accounts & Auth ──
    openAccountModal: () => void;
    closeAccountModal: () => void;
    loginMicrosoft: () => Promise<void>;
    copyMsDeviceCode: () => Promise<void>;
    cancelMsDeviceLogin: () => void;
    openMsDevicePage: () => void;
    toggleOfflineInput: () => void;
    saveOfflineAccount: () => Promise<void>;
    useSelectedRow: () => void;
    selectAccountRow: (idx: number) => void;
    deleteSelectedRow: () => Promise<void>;
    changeAccount: () => void;
    openSkinModal: () => void;
    closeSkinModal: () => void;
    previewLocalSkin: (target: any) => void | Promise<void>;
    uploadSkinToMojang: (target: any) => Promise<void>;
    updateSkinVariantPreview: (target: any) => void;
    exportSkin: () => Promise<void>;
    migrateSkins: () => Promise<void>;
    getCustomSkin: (uuid: string) => Promise<string | null>;

    // ── Discord & RPC ──
    updateRPC?: () => void;
    clearRPC?: () => void;
    reconnectDiscord: () => Promise<void>;

    // ── Mods & Catalog & Modpack Builder ──
    renderModsManager: (inst?: any) => Promise<void>;
    filterLocalMods: () => void;
    toggleMod: (filename: string, enable: boolean) => Promise<void>;
    deleteMod: (filename: string) => Promise<void>;
    checkModUpdates: () => Promise<void>;
    checkModpackUpdate: (inst?: any) => Promise<void>;
    performModpackUpdate: (...args: any[]) => Promise<void>;
    handleUpdateModpack?: (project: any) => Promise<void>;
    invalidateModCountCache?: (instName: string) => void;
    doCurseForgeUpdate: (modOrZip: any, inst?: any) => Promise<void>;
    doMrPackUpdate: (projectOrPath: any, inst?: any) => Promise<void>;
    openCatalogModal: () => void;
    closeCatalogModal: () => void;
    searchGlobalCatalog: () => Promise<void>;
    scheduleGlobalSearch: () => void;
    installGlobalMod: (...args: any[]) => Promise<void>;
    openBuilderModal: () => void;
    closeBuilderModal: () => void;
    searchBuilderMods: () => Promise<void>;
    scheduleBuilderSearch: () => void;
    addModToBuilder: (mod: any) => void;
    removeModFromBuilder: (modId: any) => void;
    renderBuilderSelectedList: () => void;
    refreshBuilderButtons: () => void;
    buildModpack: () => Promise<void>;
    handleImport: (target: any) => Promise<void>;
    handleCurseForgeImport: (...args: any[]) => Promise<void>;
    handleMrPackImport: (...args: any[]) => Promise<void>;
    handleZipImport: (f: any) => Promise<void>;
    doExport: (type?: any) => Promise<void>;

    // ── Worlds & Gallery & Packs ──
    openWorldsModal: () => Promise<void>;
    closeWorldsModal: () => void;
    backupSingleWorld: (worldName: string) => Promise<void>;
    copySingleWorld: (worldName: string) => Promise<void>;
    deleteSingleWorld: (worldName: string) => Promise<void>;
    openImportMCWorldsModal: () => Promise<void>;
    importOfficialWorld: (folderName: string) => Promise<void>;
    openRestoreModal: (worldName: string) => Promise<void>;
    restoreWorldBackup: (worldName: string, backupFile: string) => Promise<void>;
    openGalleryModal: () => Promise<void>;
    closeGalleryModal: () => void;
    deleteScreenshot: (filename: string) => Promise<void>;
    renderResourcePacksManager: (inst?: any) => Promise<void>;
    toggleResourcePack: (file: string, enable: boolean) => Promise<void>;
    deleteResourcePack: (file: string) => Promise<void>;
    renderShadersManager: (inst?: any) => Promise<void>;
    toggleShader: (file: string, enable: boolean) => Promise<void>;
    deleteShader: (file: string) => Promise<void>;
    renderServersManager: (inst?: any) => Promise<void>;
    addServer: () => Promise<void>;
    removeServer: (idx: number) => Promise<void>;
    pingServers: () => Promise<void>;
    checkServerStatus: () => Promise<void>;

    // ── Settings & Cloud & Updates ──
    openGlobalSettings: () => void;
    closeGlobalSettings: () => void;
    saveGlobalSettings: () => Promise<void>;
    saveHorizonConfig: (key?: any, value?: any) => Promise<void>;
    refreshHorizonUI: () => Promise<void>;
    refreshHorizonQuota: () => Promise<void>;
    refreshHorizonQuotaSilent: () => Promise<void>;
    changeHorizonProvider: (newProvider?: any) => Promise<void>;
    runHorizonLogin: (provider?: any) => Promise<void>;
    runHorizon: (cmd: string, args?: string[]) => Promise<any>;
    disconnectHorizon: () => Promise<void>;
    handleHorizonInstall: () => Promise<void>;
    horizonScheduleCloudRefresh: (opts?: any) => Promise<void> | void;
    horizonOpFailed: (result: any) => boolean;
    clearHorizonUpdateBadges: () => void;
    toggleDeltaThresholdRow: () => void;
    openCloudContextMenu: (e: any, instName?: any, ...args: any[]) => void;
    ctxSyncCloud: (instName?: string) => Promise<void>;
    ctxUploadCloud: (instName?: string) => Promise<void>;
    ctxDeleteCloudOnly: () => Promise<void>;
    ctxSyncCloudFromMenu: () => Promise<void>;
    ctxUploadCloudFromMenu: () => Promise<void>;
    ctxRestoreCloud: (instName?: string) => Promise<void>;
    checkCloudAtStartup: () => Promise<void>;
    checkHorizonUpdateAtStartup: () => Promise<void>;
    checkLauncherUpdates: () => Promise<void>;
    renderUpdateTab: () => void;
    startLauncherUpdate: () => void;

    // ── Java & System ──
    scanJavaVersions: (destId?: any, forceScan?: any, quiet?: any, defaultPath?: any) => Promise<any>;
    addCustomJava: (target: any, destId?: any) => void | Promise<void>;
    deleteJava: (javaPathOrVersion: any) => Promise<void>;
    downloadJavaAuto: (ver: number | any, type?: string) => Promise<any>;
    getRequiredJavaVersion: (mcVer: string) => number;
    getFriendlyJavaName: (p: string) => string;
    ctxLaunch: () => void;
    ctxEdit: () => void;
    ctxFolder: () => void;
    ctxShortcut: () => Promise<void>;
    ctxUpdateShortcut: () => Promise<void>;
    ctxDeleteShortcut: () => Promise<void>;
    ctxDelete: () => void;
    loadStorage: () => Promise<void>;
    fetchWithTimeout: (url: string, opts?: any, timeoutMs?: number) => Promise<Response>;
    loadFile: (path: string) => Promise<any>;
    pathToFileUrl: (p: string) => string;
    fetchLoaderVersions: (loader: string, mcVer: string) => Promise<string[]>;
  }
}

export {};
