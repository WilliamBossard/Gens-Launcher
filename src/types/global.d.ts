import type { GensLauncherApi, ToastType } from "./ipc";

/**
 * Fonctions et états exposés sur `window` par les modules du renderer.
 * Déclarer ici chaque global utilisé par un fichier en `// @ts-check`,
 * plutôt que de passer par un alias `any` (qui désactive la vérification).
 */
declare global {
  interface Window {
    api: GensLauncherApi;

    // ── src/utils.js ──
    /** Traduction : renvoie la chaîne de la langue courante, sinon `fallback`. */
    t: (key: string, fallback?: string) => string;
    showToast: (msg: unknown, type?: ToastType) => void;
    showCustomConfirm: (msg: string, isDestructive?: boolean) => Promise<boolean>;
    showLoading: (text: string, percent?: number | null) => void;
    updateLoadingPercent: (percent: number | null, text?: string | null) => void;
    hideLoading: () => void;
    escapeHTML: (str: unknown) => string;
    sanitizeHTML: (str: string) => string;
    /** Nom de dossier disque d'une instance (caractères non alphanumériques → `_`). */
    safeDir: (name: string) => string;

    // ── src/uiCore.js ──
    /** État réseau réel (navigator.onLine + vérification active). */
    isTrulyOnline: boolean;

    // ── src/ui/CloudUI.js ──
    checkCloudAtStartup: () => Promise<void>;
    checkHorizonUpdateAtStartup: () => Promise<void>;

    // ── src/ui/ServerUI.js ──
    checkServerStatus: () => Promise<void>;
  }
}

export {};
