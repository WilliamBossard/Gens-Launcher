// @ts-check

/**
 * Vérifie si un chemin Java système correspond à une version majeure donnée.
 * @param {string[]} paths
 * @param {number} majorVersion
 * @returns {boolean}
 */
export function hasSystemJavaForVersion(paths, majorVersion) {
    if (!Array.isArray(paths)) return false;
    return paths.some((p) => {
        const pLower = String(p).toLowerCase();
        if (majorVersion === 8) {
            return pLower.includes("1.8.0") || pLower.includes("jre8") || pLower.includes("jdk8") || pLower.includes("jdk-8") || pLower.includes("jre-8");
        }
        return pLower.includes(`jdk-${majorVersion}`) || pLower.includes(`jre-${majorVersion}`) || pLower.includes(`jdk${majorVersion}`) || pLower.includes(`jre${majorVersion}`);
    });
}
