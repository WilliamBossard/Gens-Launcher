const fs = require('fs');
const path = require('path');

/**
 * electron-builder afterPack hook (Linux).
 * Sépare le comportement .deb (sandbox OS actif via SUID / AppArmor) de l'AppImage
 * (sonde dynamique des user namespaces au démarrage, avec fallback --no-sandbox
 * uniquement lorsque le noyau / AppArmor bloque CLONE_NEWUSER en FUSE).
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
exports.default = async function afterPackLinuxSandbox(context) {
    if (context.electronPlatformName !== 'linux') return;

    const appOutDir = context.appOutDir;
    const exeName = context.packager?.executableName || 'gens-launcher';
    const exePath = path.join(appOutDir, exeName);
    const binPath = path.join(appOutDir, `${exeName}.bin`);

    if (!fs.existsSync(exePath)) return;

    if (!fs.existsSync(binPath)) {
        await fs.promises.rename(exePath, binPath);
    }

    const wrapper = `#!/bin/sh
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/${exeName}.bin"

if [ -n "$APPIMAGE" ]; then
    USERNS_OK=0
    if command -v unshare >/dev/null 2>&1; then
        if unshare --user true >/dev/null 2>&1; then
            USERNS_OK=1
        fi
    elif [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
        if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "0" ]; then
            USERNS_OK=1
        fi
    elif [ -r /proc/sys/kernel/unprivileged_userns_clone ]; then
        if [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "1" ]; then
            USERNS_OK=1
        fi
    fi

    if [ "$USERNS_OK" = "1" ]; then
        exec "$BIN" --is-appimage "$@"
    else
        echo "[Gens-Launcher] Info : user namespaces restreints sur cet hôte AppImage, fallback --no-sandbox. Préférez le paquet .deb pour le sandbox OS complet." >&2
        exec "$BIN" --is-appimage --no-sandbox --disable-setuid-sandbox "$@"
    fi
fi

exec "$BIN" "$@"
`;

    await fs.promises.writeFile(exePath, wrapper, { mode: 0o755 });
    await fs.promises.chmod(exePath, 0o755);
};

