// @ts-check

/**
 * Extrait la partie semver d'un numéro de version Modrinth (ex: "mc26.3-0.9.3-fabric" -> "0.9.3").
 * @param {string} raw
 * @returns {string}
 */
export function normalizeModVersionString(raw) {
    let s = String(raw || "").trim().replace(/^v/i, "");
    s = s.replace(/^(?:mc\d+(?:\.\d+)*[-_+]|(?:fabric|forge|neoforge|quilt)[-_+])+/i, "");
    s = s.replace(/[-_+](?:fabric|forge|neoforge|quilt)(?=$|\+)/i, "");
    return s;
}

/**
 * Normalise une version Fabric/Maven en { major, minor, patch, pre }.
 * @param {string} raw
 */
export function parseModSemver(raw) {
    const clean = normalizeModVersionString(raw).split("+")[0];
    const dashIdx = clean.indexOf("-");
    const core = dashIdx >= 0 ? clean.slice(0, dashIdx) : clean;
    const pre = dashIdx >= 0 ? (clean.slice(dashIdx + 1) || "\x00") : "";
    const parts = core.split(".").map((n) => parseInt(n, 10));
    return {
        major: Number.isFinite(parts[0]) ? parts[0] : 0,
        minor: Number.isFinite(parts[1]) ? parts[1] : 0,
        patch: Number.isFinite(parts[2]) ? parts[2] : 0,
        pre
    };
}

/**
 * Compare deux versions semver (-1, 0, +1). Une pre-release est < à la release correspondante.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareModSemver(a, b) {
    const pa = parseModSemver(a);
    const pb = parseModSemver(b);
    if (pa.major !== pb.major) return pa.major - pb.major;
    if (pa.minor !== pb.minor) return pa.minor - pb.minor;
    if (pa.patch !== pb.patch) return pa.patch - pb.patch;
    if (!pa.pre && pb.pre) return 1;
    if (pa.pre && !pb.pre) return -1;
    if (pa.pre === pb.pre) return 0;
    return pa.pre < pb.pre ? -1 : 1;
}

/**
 * Évalue un prédicat simple Fabric/npm (>=, <=, >, <, =, ^, ~, wildcard).
 * @param {string} version
 * @param {string} token
 * @returns {boolean}
 */
function matchSinglePredicate(version, token) {
    const t = token.trim();
    if (!t || t === "*" || t.toLowerCase() === "x") return true;
    const v = parseModSemver(version);

    if (t.startsWith(">=")) return compareModSemver(version, t.slice(2)) >= 0;
    if (t.startsWith("<=")) return compareModSemver(version, t.slice(2)) <= 0;
    if (t.startsWith(">")) return compareModSemver(version, t.slice(1)) > 0;
    if (t.startsWith("<")) return compareModSemver(version, t.slice(1)) < 0;
    if (t.startsWith("=")) return compareModSemver(version, t.slice(1)) === 0;
    if (t.startsWith("^")) {
        const base = t.slice(1);
        const pb = parseModSemver(base);
        if (compareModSemver(version, base) < 0) return false;
        if (pb.major > 0) return v.major === pb.major;
        if (pb.minor > 0) return v.major === 0 && v.minor === pb.minor;
        return v.major === 0 && v.minor === 0 && v.patch === pb.patch;
    }
    if (t.startsWith("~")) {
        const base = t.slice(1);
        const pb = parseModSemver(base);
        if (compareModSemver(version, base) < 0) return false;
        return v.major === pb.major && v.minor === pb.minor;
    }
    if (/\.x$/i.test(t) || /\.\*$/.test(t)) {
        const prefix = t.replace(/\.[x*]$/i, "").split(".").map((n) => parseInt(n, 10));
        if (prefix.length === 1) return v.major === prefix[0];
        if (prefix.length >= 2) return v.major === prefix[0] && v.minor === prefix[1];
    }
    return compareModSemver(version, t) === 0;
}

/**
 * Vérifie si `version` satisfait une contrainte Fabric/Quilt (chaîne ou tableau de chaînes).
 * @param {string} version
 * @param {string | string[] | null | undefined} rangeSpec
 * @returns {boolean}
 */
export function satisfiesFabricRange(version, rangeSpec) {
    if (!rangeSpec || !version) return true;
    const ranges = Array.isArray(rangeSpec) ? rangeSpec : [rangeSpec];
    if (ranges.length === 0) return true;
    return ranges.some((orGroup) => {
        const branches = String(orGroup).split("||");
        return branches.some((branch) => {
            const preds = branch.trim().split(/\s+/).filter(Boolean);
            if (preds.length === 0) return true;
            return preds.every((pred) => matchSinglePredicate(version, pred));
        });
    });
}

/**
 * Détecte les conflits bloquants (dépendances et breaks) entre un mod candidat
 * et la liste des mods déjà installés, avec l'identifiant du mod en conflit.
 * @param {{ id: string; version: string; depends?: Record<string, any>; breaks?: Record<string, any>; conflicts?: Record<string, any> }} candidate
 * @param {Array<{ file?: string; id: string; version: string; depends?: Record<string, any>; breaks?: Record<string, any>; conflicts?: Record<string, any> }>} installedMods
 * @returns {Array<{ message: string; existingId: string; existingFile?: string }>}
 */
export function findModCompatibilityIssues(candidate, installedMods) {
    /** @type {Array<{ message: string; existingId: string; existingFile?: string }>} */
    const issues = [];
    if (!candidate || !candidate.id || !candidate.version || !Array.isArray(installedMods)) return issues;
    const candId = candidate.id.toLowerCase();
    /** @param {string} k @param {string} fb */
    const tr = (k, fb) => (typeof globalThis !== "undefined" && /** @type {any} */ (globalThis).window?.t)
        ? /** @type {any} */ (globalThis).window.t(k, fb)
        : fb;

    for (const existing of installedMods) {
        if (!existing || !existing.id || !existing.version) continue;
        const exId = existing.id.toLowerCase();
        if (exId === candId) continue;

        // 1. Le mod déjà installé déclare `depends` sur le nouveau mod
        if (existing.depends && typeof existing.depends === "object") {
            for (const [depId, range] of Object.entries(existing.depends)) {
                if (depId.toLowerCase() === candId && !satisfiesFabricRange(candidate.version, range)) {
                    const msg = tr("msg_compat_requires", "{mod} ({ver}) requiert {dep} {range}, mais la version candidate est {candVer}")
                        .replace("{mod}", existing.id)
                        .replace("{ver}", existing.version)
                        .replace("{dep}", candidate.id)
                        .replace("{range}", String(Array.isArray(range) ? range.join(" | ") : range))
                        .replace("{candVer}", candidate.version);
                    issues.push({ message: msg, existingId: existing.id, existingFile: existing.file });
                }
            }
        }

        // 2. Le nouveau mod déclare `depends` sur un mod déjà installé
        if (candidate.depends && typeof candidate.depends === "object") {
            for (const [depId, range] of Object.entries(candidate.depends)) {
                if (depId.toLowerCase() === exId && !satisfiesFabricRange(existing.version, range)) {
                    const msg = tr("msg_compat_requires", "{mod} ({ver}) requiert {dep} {range}, mais la version candidate est {candVer}")
                        .replace("{mod}", candidate.id)
                        .replace("{ver}", candidate.version)
                        .replace("{dep}", existing.id)
                        .replace("{range}", String(Array.isArray(range) ? range.join(" | ") : range))
                        .replace("{candVer}", existing.version);
                    issues.push({ message: msg, existingId: existing.id, existingFile: existing.file });
                }
            }
        }

        // 3. `breaks` dans un sens ou l'autre (on ignore `conflicts` qui est purement consultatif dans Fabric)
        const checkBreakMap = (/** @type {Record<string, any> | undefined} */ map, /** @type {string} */ sourceId, /** @type {string} */ sourceVer, /** @type {string} */ targetId, /** @type {string} */ targetVer) => {
            if (!map || typeof map !== "object") return;
            for (const [bId, range] of Object.entries(map)) {
                if (bId.toLowerCase() === targetId && satisfiesFabricRange(targetVer, range)) {
                    const rangeLabel = Array.isArray(range) ? range.join(" | ") : String(range || "*");
                    const msg = tr("msg_compat_breaks", "{mod} ({ver}) est incompatible avec {other} ({otherVer})")
                        .replace("{mod}", sourceId)
                        .replace("{ver}", sourceVer)
                        .replace("{other}", targetId)
                        .replace("{otherVer}", `${targetVer} [${rangeLabel}]`);
                    issues.push({ message: msg, existingId: existing.id, existingFile: existing.file });
                }
            }
        };
        checkBreakMap(existing.breaks, existing.id, existing.version, candId, candidate.version);
        checkBreakMap(candidate.breaks, candidate.id, candidate.version, exId, existing.version);
    }

    return issues;
}

/**
 * Détecte les conflits entre un mod candidat (`id`, `version`, `depends`, `breaks`)
 * et la liste des mods déjà installés.
 * @param {{ id: string; version: string; depends?: Record<string, any>; breaks?: Record<string, any>; conflicts?: Record<string, any> }} candidate
 * @param {Array<{ file?: string; id: string; version: string; depends?: Record<string, any>; breaks?: Record<string, any>; conflicts?: Record<string, any> }>} installedMods
 * @returns {string[]}
 */
export function detectModCompatibilityConflicts(candidate, installedMods) {
    return findModCompatibilityIssues(candidate, installedMods).map((i) => i.message);
}
