const path = window.api.path;
const dataDir = path.join(window.api.appData, "GensLauncher");

export const store = {
    dataDir: dataDir,
    instancesRoot: path.join(dataDir, "instances"),
    langDir: path.join(dataDir, "lang"),
    logsDir: path.join(dataDir, "logs"),
    instanceFile: path.join(dataDir, "instances.json"),
    accountFile: path.join(dataDir, "accounts.json"),
    settingsFile: path.join(dataDir, "settings.json"),

    allInstances: [],
    allAccounts: [],
    rawVersions: [],
    globalSettings: {
        defaultRam: 4096,
        unlockedAchievements: [],
        defaultJavaPath: "",
        cfApiKey: "", 
        serverIp: "",
        language: null,
        theme: { accent: "#007acc", bg: "", dim: 0.5, blur: 5, panelOpacity: 0.6 },
        launcherVisibility: "keep",
        newsCollapsed: false,
        disableRPC: false,       
        multiInstance: false,
        autoDownloadUpdates: false,
        totalInstancesCreated: 0 
    },
    currentLangObj: {},

    selectedInstanceIdx: null,
    selectedAccountIdx: null,
    uiSelectedAccRow: null,
    isGameRunning: false,
    activeInstances: new Set(), 
    sessionStartTime: 0,
    maxSafeRam: 4096,
    collapsedGroups: {},
    pendingIconPath: null,
    dragCounter: 0,
    primaryRpcInstance: null,
    pendingLauncherUpdate: null,
    horizonActive: false,      

    defaultIcons: {
        vanilla: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%2317B139'/%3E%3Crect x='1' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='5' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='3' y='4' width='2' height='3' fill='%23000'/%3E%3C/svg%3E",
        forge: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%232b2b2b'/%3E%3Cpath d='M3 4h10v3H3zM6 7h4v2H6zM4 9h8v2H4zM2 11h12v3H2z' fill='%238c8c8c'/%3E%3C/svg%3E",
        fabric: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23e2d4b7'/%3E%3Cpath d='M0 4h16v2H0zM0 10h16v2H0zM4 0h2v16H4zM10 0h2v16H10z' fill='%23c8b593'/%3E%3C/svg%3E",
        quilt: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%237c3aed'/%3E%3Crect x='0' y='0' width='8' height='8' fill='%239f67f5'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%239f67f5'/%3E%3Crect x='3' y='3' width='2' height='2' fill='%23fff'/%3E%3Crect x='11' y='11' width='2' height='2' fill='%23fff'/%3E%3C/svg%3E",
        neoforge: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23f48a21'/%3E%3Cpath d='M3 4h10v3H3zM6 7h4v2H6zM4 9h8v2H4zM2 11h12v3H2z' fill='%23ffffff'/%3E%3C/svg%3E"
    }
};