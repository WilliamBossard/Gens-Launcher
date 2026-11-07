interface Window {
    api: {
        send: (channel: string, data?: any) => void;
        invoke: (channel: string, data?: any) => Promise<any>;
        on: (channel: string, func: (...args: any[]) => void) => (() => void) | undefined;
        nbt: {
            parse: (arr: any) => Promise<any>;
            write: (data: any) => Uint8Array;
        };
        security: {
            writeJSON: (filePath: string, data: any) => Promise<any>;
            readJSON: (filePath: string) => Promise<any>;
            writeJSONAsync: (filePath: string, data: any) => Promise<any>;
            readJSONAsync: (filePath: string) => Promise<any>;
        };
        tools: {
            hashFile: (filePath: string, algo: string) => Promise<string>;
            hashBuffer: (arr: any, algo: string) => Promise<string>;
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
                readFile: (p: string, enc?: any) => Promise<any>;
                readdir: (p: string) => Promise<string[]>;
                stat: (p: string) => Promise<{
                    isDirectory: () => boolean;
                    isFile: () => boolean;
                    size: number;
                    mtime: Date;
                    mtimeMs: number;
                    birthtime: Date;
                }>;
                writeFile: (p: string, d: any, enc?: any) => Promise<void>;
                rm: (p: string, opts?: any) => Promise<void>;
                cp: (s: string, d: string, o?: any) => Promise<void>;
                unlink: (p: string) => Promise<void>;
                chmod: (p: string, mode: any) => Promise<void>;
                mkdir: (p: string, opts?: any) => Promise<void>;
                rename: (oldP: string, newP: string) => Promise<void>;
                appendFile: (p: string, d: any, enc?: any) => Promise<void>;
                access: (p: string, mode?: any) => Promise<void>;
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
        getFilePath: (file: any) => string;
        copyImageToSandbox: (srcPath: string, destName: string, subDir?: string) => Promise<any>;
        copyFileToSandbox: (srcPath: string, destName: string) => Promise<any>;
    };
    t: (key: string, fallback?: string) => string;
    showToast: (msg: string, type?: "info" | "error" | "success" | "warn") => void;
    existsSafe: (p: string) => Promise<boolean>;
    safeWriteJSONAsync: (p: string, data: any) => Promise<any>;
    safeWriteJSON: (p: string, data: any) => Promise<any>;
    safeUnlink: (p: string) => Promise<void>;
    safeRm: (p: string, options?: any) => Promise<void>;
    safeDir: (name: string) => string;
    sameFolderSlug: (a: string, b: string) => boolean;
    sameFsPath: (a: string, b: string) => boolean;
    resolveInstanceFolder: (name: string) => string;
    resolveInstanceName: (name: string) => string;
    checkAchievement: (id: string) => void;
    showLoading: (text: string, percent?: number | null) => void;
    updateLoadingPercent: (percent: number | null, text?: string | null) => void;
    hideLoading: () => void;
    copyToClipboard: (text: string) => Promise<boolean>;
    showCustomConfirm: (msg: string, isDestructive?: boolean) => Promise<boolean>;
    [key: string]: any;
}

declare function t(key: string, fallback?: string): string;

