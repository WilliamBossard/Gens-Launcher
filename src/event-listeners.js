// @ts-check
import { store } from "./store.js";
/** @type {<T extends HTMLElement = any>(id: string) => T | null} */
const $ = (id) => /** @type {any} */ (document.getElementById(id));

document.addEventListener('DOMContentLoaded', () => {
    const checkOffline = (/** @type {any} */ e = undefined) => {
        if (store.globalSettings.offlineMode || !window.isTrulyOnline) {
            if (window.showToast) window.showToast(window.t("msg_err_offline", "Cette fonctionnalité nécessite une connexion internet."), "error");
            if (e) { e.preventDefault(); e.stopPropagation(); }
            return true;
        }
        return false;
    };
    window.checkOffline = checkOffline;
    $('btn-save-first-launch')?.addEventListener('click', () => window.saveFirstLaunch());
    $('btn-close-updates-modal')?.addEventListener('click', () => { window.closeModal('modal-updates'); });
    $('btn-ms-login')?.addEventListener('click', (/** @type {any} */ e) => { if(!checkOffline(e)) window.loginMicrosoft(); });
    $('btn-toggle-offline')?.addEventListener('click', () => window.toggleOfflineInput());
    $('btn-save-offline')?.addEventListener('click', () => window.saveOfflineAccount());
    $('btn-use-acc')?.addEventListener('click', () => window.useSelectedRow());
    $('btn-skin-acc')?.addEventListener('click', (/** @type {any} */ e) => { if (checkOffline(e)) return; window.openSkinModal(); });
    $('btn-del-acc')?.addEventListener('click', () => window.deleteSelectedRow());
    $('btn-close-account-modal')?.addEventListener('click', () => window.closeAccountModal());
    $('btn-open-instance-modal')?.addEventListener('click', () => window.openInstanceModal());
    $('btn-toolbar-builder')?.addEventListener('click', (/** @type {any} */ e) => {
        if (checkOffline(e)) return;
        window.openBuilderModal();
    });
    $('btn-import-upload')?.addEventListener('click', () => $('import-upload').click());
    $('import-upload')?.addEventListener('change', (/** @type {any} */ e) => {
        if (window.handleImport) window.handleImport(e.target);
    });
    $('btn-toolbar-catalog')?.addEventListener('click', (/** @type {any} */ e) => { if(!checkOffline(e)) window.openCatalogModal(); });
    $('btn-open-global-settings')?.addEventListener('click', () => window.openGlobalSettings());
    $('btn-show-console')?.addEventListener('click', () => { $('console-container').style.display = 'block'; });
    $('btn-open-stats')?.addEventListener('click', () => window.openStatsModal());
    $('btn-open-account-modal')?.addEventListener('click', () => window.openAccountModal());
    $('btn-copy-logs')?.addEventListener('click', () => window.copyLogs());
    $('btn-hide-console')?.addEventListener('click', () => { $('console-container').style.display = 'none'; });
    $('btn-edit')?.addEventListener('click', () => window.openEditModal('tab-general'));
    $('btn-mods')?.addEventListener('click', () => window.openEditModal('tab-mods'));
    $('btn-saves')?.addEventListener('click', () => window.openWorldsModal());
    $('btn-screens')?.addEventListener('click', () => window.openGalleryModal());
    $('btn-folder')?.addEventListener('click', () => window.openDir(''));
    $('btn-delete')?.addEventListener('click', () => window.deleteInstance());
    $('btn-copy')?.addEventListener('click', () => window.copyInstance());
    $('btn-export')?.addEventListener('click', () => window.exportInstance());
    $('btn-clean-cache')?.addEventListener('click', () => window.cleanCache());
    $('btn-close-stats')?.addEventListener('click', () => window.closeStatsModal());
    $('btn-close-import-mc')?.addEventListener('click', () => { window.closeModal('modal-import-mc'); });
    $('btn-open-import-mc')?.addEventListener('click', () => window.openImportMCWorldsModal());
    $('btn-open-dir-root')?.addEventListener('click', () => window.openDir(''));
    $('btn-open-dir-saves')?.addEventListener('click', () => window.openDir('saves'));
    $('btn-open-dir-backups')?.addEventListener('click', () => window.openDir('backups'));
    $('btn-close-worlds')?.addEventListener('click', () => window.closeWorldsModal());
    $('btn-close-restore')?.addEventListener('click', () => { window.closeModal('modal-restore'); });
    $('btn-open-dir-root-gallery')?.addEventListener('click', () => window.openDir(''));
    $('btn-open-dir-screenshots')?.addEventListener('click', () => window.openDir('screenshots'));
    $('btn-close-gallery')?.addEventListener('click', () => window.closeGalleryModal());
    $('btn-search-catalog')?.addEventListener('click', () => window.searchGlobalCatalog());
    $('btn-close-catalog')?.addEventListener('click', () => window.closeCatalogModal());
    $('btn-close-instance-modal')?.addEventListener('click', () => window.closeInstanceModal());
    $('btn-save-instance')?.addEventListener('click', () => window.saveInstance());
    $('tab-btn-glob-gen')?.addEventListener('click', () => window.switchTabGlob('tab-glob-gen'));
    $('tab-btn-glob-app')?.addEventListener('click', () => window.switchTabGlob('tab-glob-app'));
    $('tab-btn-glob-updates')?.addEventListener('click', () => window.switchTabGlob('tab-glob-updates'));
    $('tab-btn-glob-java')?.addEventListener('click', () => window.switchTabGlob('tab-glob-java'));
    $('tab-btn-glob-horizon')?.addEventListener('click', () => window.switchTabGlob('tab-glob-horizon'));
    $('btn-reconnect-discord')?.addEventListener('click', () => window.reconnectDiscord());
    $('btn-scan-java')?.addEventListener('click', () => window.scanJavaVersions());
    $('btn-custom-java-browse')?.addEventListener('click', () => $('custom-java-file').click());
    $('btn-save-default-options')?.addEventListener('click', () => window.saveDefaultOptions());
    $('btn-save-default-servers')?.addEventListener('click', () => window.saveDefaultServers());
    $('btn-bg-upload')?.addEventListener('click', () => $('bg-upload').click());
    $('btn-clear-bg')?.addEventListener('click', () => { $('global-bg-path').value = ''; });
    $('btn-start-update')?.addEventListener('click', () => window.startLauncherUpdate());
    $('btn-check-launcher')?.addEventListener('click', (/** @type {any} */ e) => { if (checkOffline(e)) return; window.checkLauncherUpdates(); });
    $('btn-close-global-settings')?.addEventListener('click', () => window.closeGlobalSettings());
    $('btn-save-global-settings')?.addEventListener('click', () => window.saveGlobalSettings());
    $('tab-btn-general')?.addEventListener('click', () => window.switchTab('tab-general'));
    $('tab-btn-mods')?.addEventListener('click', () => window.switchTab('tab-mods'));
    $('tab-btn-shaders')?.addEventListener('click', () => window.switchTab('tab-shaders'));
    $('tab-btn-resourcepacks')?.addEventListener('click', () => window.switchTab('tab-resourcepacks'));
    $('tab-btn-servers')?.addEventListener('click', () => window.switchTab('tab-servers'));
    $('tab-btn-backups')?.addEventListener('click', () => window.switchTab('tab-backups'));
    $('tab-btn-java')?.addEventListener('click', () => window.switchTab('tab-java'));
    $('tab-btn-notes')?.addEventListener('click', () => window.switchTab('tab-notes'));
    $('btn-edit-icon-upload')?.addEventListener('click', () => $('edit-icon-upload').click());
    $('btn-open-icon-gallery')?.addEventListener('click', () => window.openIconGallery());
    $('btn-force-inject-options')?.addEventListener('click', () => window.forceInjectOptions());
    $('btn-check-mod-updates')?.addEventListener('click', (/** @type {any} */ e) => { if (checkOffline(e)) return; window.checkModUpdates(); });
    $('btn-open-dir-mods')?.addEventListener('click', () => window.openDir('mods'));
    $('btn-open-catalog-mods')?.addEventListener('click', (/** @type {any} */ e) => { if (checkOffline(e)) return; window.closeEditModal(); $('catalog-type').value = 'mod'; window.openCatalogModal(); });
    $('btn-open-dir-shaderpacks')?.addEventListener('click', () => window.openDir('shaderpacks'));
    $('btn-open-catalog-shaders')?.addEventListener('click', (/** @type {any} */ e) => { if (checkOffline(e)) return; window.closeEditModal(); $('catalog-type').value = 'shader'; window.openCatalogModal(); });
    $('btn-open-dir-resourcepacks')?.addEventListener('click', () => window.openDir('resourcepacks'));
    $('btn-open-catalog-resourcepacks')?.addEventListener('click', (/** @type {any} */ e) => { if (checkOffline(e)) return; window.closeEditModal(); $('catalog-type').value = 'resourcepack'; window.openCatalogModal(); });
    $('btn-add-server')?.addEventListener('click', () => window.addServer());
    $('btn-open-dir-backups-edit')?.addEventListener('click', () => window.openDir('backups'));
    $('btn-scan-java-edit')?.addEventListener('click', () => window.scanJavaVersions());
    $('btn-custom-edit-java-browse')?.addEventListener('click', () => $('custom-edit-java-file').click());
    $('btn-close-edit-modal')?.addEventListener('click', () => window.closeEditModal());
    $('btn-save-edit')?.addEventListener('click', () => window.saveEdit());
    $('ms-device-btn-copy')?.addEventListener('click', () => window.copyMsDeviceCode());
    $('ms-device-btn-open')?.addEventListener('click', () => window.openMsDevicePage());
    $('ms-device-btn-cancel')?.addEventListener('click', () => window.cancelMsDeviceLogin());
    $('btn-upload-skin')?.addEventListener('click', () => $('skin-upload').click());
    $('btn-export-skin')?.addEventListener('click', () => window.exportSkin());
    $('btn-skin-mojang-upload')?.addEventListener('click', () => $('skin-mojang-input').click());
    $('btn-close-skin-modal')?.addEventListener('click', () => window.closeSkinModal());
    $('btn-export-zip-light')?.addEventListener('click', () => window.doExport('zip_light'));
    $('btn-export-zip-full')?.addEventListener('click', () => window.doExport('zip_full'));
    $('btn-close-export-modal')?.addEventListener('click', () => { window.closeModal('modal-export'); });
    $('btn-copy-crash-log')?.addEventListener('click', () => window.copyCrashLog());
    $('btn-close-crash-modal')?.addEventListener('click', () => { window.closeModal('modal-crash'); });
    $('btn-close-icon-gallery')?.addEventListener('click', () => { window.closeModal('modal-icon-gallery'); });
    $('btn-build-modpack')?.addEventListener('click', () => window.buildModpack());
    $('btn-close-builder-modal')?.addEventListener('click', () => window.closeBuilderModal());
    $('ctx-launch')?.addEventListener('click', () => { if (window.ctxLaunch) window.ctxLaunch(); });
    $('ctx-cloud-import')?.addEventListener('click', () => window.ctxSyncCloud());
    $('ctx-cloud-upload')?.addEventListener('click', () => window.ctxUploadCloud());
    $('ctx-folder')?.addEventListener('click', () => window.ctxFolder());
    $('ctx-edit')?.addEventListener('click', () => window.ctxEdit());
    $('ctx-create-shortcut')?.addEventListener('click', () => window.ctxShortcut());
    $('ctx-delete-shortcut')?.addEventListener('click', () => window.ctxDeleteShortcut());
    $('ctx-delete')?.addEventListener('click', () => window.ctxDelete());
    $('ctx-cloud-restore-item')?.addEventListener('click', () => window.ctxRestoreCloud());
    $('ctx-cloud-sync-item')?.addEventListener('click', () => window.ctxSyncCloudFromMenu());
    $('ctx-cloud-upload-item')?.addEventListener('click', () => window.ctxUploadCloudFromMenu());
    $('ctx-delete-cloud-only')?.addEventListener('click', () => window.ctxDeleteCloudOnly());
    $('auto-crash-banner')?.addEventListener('click', () => window.openLastCrashReport());
    $('auto-cancel-btn')?.addEventListener('click', () => window.cancelAutoLaunch());
    $('account-dropdown')?.addEventListener('change', () => window.changeAccount());
    $('search-bar')?.addEventListener('input', () => window.scheduleSearch());
    $('sort-dropdown')?.addEventListener('change', () => window.renderUI());
    $('check-beta')?.addEventListener('change', (/** @type {any} */ e) => window.updateVersionList(e.target.checked));
    $('new-version')?.addEventListener('change', () => window.updateLoaderVersions());
    $('new-loader')?.addEventListener('change', () => window.updateLoaderVersions());
    $('new-ram-input')?.addEventListener('input', (/** @type {any} */ e) => {
        const s = $('new-ram-slider'); if (s) s.value = e.target.value;
    });
    $('new-ram-slider')?.addEventListener('input', (/** @type {any} */ e) => {
        const i = $('new-ram-input'); if (i) i.value = e.target.value;
    });
    $('global-lang')?.addEventListener('change', (/** @type {any} */ e) => window.changeLanguage(e.target.value));
    $('global-ram-input')?.addEventListener('input', (/** @type {any} */ e) => {
        const s = $('global-ram-slider'); if (s) s.value = e.target.value;
    });
    $('global-ram-slider')?.addEventListener('input', (/** @type {any} */ e) => {
        const i = $('global-ram-input'); if (i) i.value = e.target.value;
    });
    $('custom-java-file')?.addEventListener('change', (/** @type {any} */ e) => window.addCustomJava(e.target, 'global-java'));
    $('bg-upload')?.addEventListener('change', (/** @type {any} */ e) => {
        const p = $('global-bg-path');
        if (p && e.target.files[0]) p.value = window.api.getFilePath(e.target.files[0]);
    });
    $('edit-mc-version')?.addEventListener('change', () => window.updateEditLoaderVersions());
    $('edit-show-snapshots')?.addEventListener('change', () => window.toggleEditSnapshots());
    $('edit-loader-type')?.addEventListener('change', () => window.updateEditLoaderVersions());
    $('edit-ram-input')?.addEventListener('input', (/** @type {any} */ e) => {
        const s = $('edit-ram-slider'); if (s) s.value = e.target.value;
    });
    $('edit-ram-slider')?.addEventListener('input', (/** @type {any} */ e) => {
        const i = $('edit-ram-input'); if (i) i.value = e.target.value;
    });
    $('local-mod-search')?.addEventListener('input', () => window.filterLocalMods());
    $('custom-edit-java-file')?.addEventListener('change', (/** @type {any} */ e) => window.addCustomJava(e.target, 'edit-javapath'));
    $('edit-jvm-profile')?.addEventListener('change', () => window.updateJvmDesc());
    $('skin-upload')?.addEventListener('change', (/** @type {any} */ e) => window.previewLocalSkin(e.target));
    $('edit-icon-upload')?.addEventListener('change', (/** @type {any} */ e) => window.previewInstanceIcon(e.target));
    $('skin-variant-select')?.addEventListener('change', (/** @type {any} */ e) => window.updateSkinVariantPreview(e.target));
    $('skin-mojang-input')?.addEventListener('change', (/** @type {any} */ e) => window.uploadSkinToMojang(e.target));
    $('builder-version')?.addEventListener('change', () => window.searchBuilderMods());
    $('builder-loader')?.addEventListener('change', () => window.searchBuilderMods());
    $('builder-type')?.addEventListener('change', () => window.searchBuilderMods());
    $('builder-source')?.addEventListener('change', () => window.searchBuilderMods());
    $('builder-search')?.addEventListener('input', () => window.scheduleBuilderSearch());
    $('acc-name')?.addEventListener('keydown', (/** @type {any} */ e) => { if (e.key === 'Enter') window.saveOfflineAccount(); });
    $('catalog-search')?.addEventListener('keydown', (/** @type {any} */ e) => { if (e.key === 'Enter') window.searchGlobalCatalog(); });
    ['catalog-source', 'catalog-type', 'catalog-loader', 'catalog-version'].forEach(id => {
        $(id)?.addEventListener('change', () => { if (typeof window.searchGlobalCatalog === 'function') window.searchGlobalCatalog(); });
    });
    $('new-server-ip')?.addEventListener('keydown', (/** @type {any} */ e) => { if (e.key === 'Enter') window.addServer(); });
    document.querySelectorAll('.export-card').forEach((/** @type {any} */ card) => {
        card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--accent)'; });
        card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--border)'; });
    });
});