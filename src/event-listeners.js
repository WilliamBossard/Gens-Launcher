/**
 * ============================================================
 * EVENT LISTENERS — Remplace tous les onclick="" de index.html
 * Généré automatiquement lors du refactoring CSP (suppression unsafe-inline)
 * ============================================================
 */
document.addEventListener('DOMContentLoaded', () => {

    // ── PREMIER LANCEMENT ──────────────────────────────────────
    document.getElementById('btn-save-first-launch')?.addEventListener('click', () => saveFirstLaunch());

    // ── MODAL MISES À JOUR ─────────────────────────────────────
    document.getElementById('btn-close-updates-modal')?.addEventListener('click', () => { window.closeModal('modal-updates'); });

    // ── COMPTE MICROSOFT ──────────────────────────────────────
    document.getElementById('btn-ms-login')?.addEventListener('click', () => loginMicrosoft());
    document.getElementById('btn-toggle-offline')?.addEventListener('click', () => toggleOfflineInput());
    document.getElementById('btn-save-offline')?.addEventListener('click', () => saveOfflineAccount());
    document.getElementById('btn-use-acc')?.addEventListener('click', () => useSelectedRow());
    document.getElementById('btn-skin-acc')?.addEventListener('click', () => openSkinModal());
    document.getElementById('btn-del-acc')?.addEventListener('click', () => deleteSelectedRow());
    document.getElementById('btn-close-account-modal')?.addEventListener('click', () => closeAccountModal());

    // ── TOOLBAR ────────────────────────────────────────────────
    document.getElementById('btn-open-instance-modal')?.addEventListener('click', () => openInstanceModal());
    document.getElementById('btn-toolbar-builder')?.addEventListener('click', () => openBuilderModal());
    document.getElementById('btn-import-upload')?.addEventListener('click', () => document.getElementById('import-upload').click());
    document.getElementById('btn-toolbar-catalog')?.addEventListener('click', () => openCatalogModal());
    document.getElementById('btn-open-global-settings')?.addEventListener('click', () => openGlobalSettings());
    document.getElementById('btn-show-console')?.addEventListener('click', () => { document.getElementById('console-container').style.display = 'block'; });
    document.getElementById('btn-open-stats')?.addEventListener('click', () => openStatsModal());
    document.getElementById('btn-open-account-modal')?.addEventListener('click', () => openAccountModal());

    // ── CONSOLE / LOGS ─────────────────────────────────────────
    document.getElementById('btn-copy-logs')?.addEventListener('click', () => copyLogs());
    document.getElementById('btn-hide-console')?.addEventListener('click', () => { document.getElementById('console-container').style.display = 'none'; });

    // ── BARRE D'INSTANCE ──────────────────────────────────────
    document.getElementById('btn-edit')?.addEventListener('click', () => openEditModal('tab-general'));
    document.getElementById('btn-mods')?.addEventListener('click', () => openEditModal('tab-mods'));
    document.getElementById('btn-saves')?.addEventListener('click', () => openWorldsModal());
    document.getElementById('btn-screens')?.addEventListener('click', () => openGalleryModal());
    document.getElementById('btn-folder')?.addEventListener('click', () => openDir(''));
    document.getElementById('btn-delete')?.addEventListener('click', () => deleteInstance());
    document.getElementById('btn-copy')?.addEventListener('click', () => copyInstance());
    document.getElementById('btn-export')?.addEventListener('click', () => exportInstance());
    document.getElementById('btn-update-modpack')?.addEventListener('click', () => document.getElementById('update-modpack-input').click());
    document.getElementById('btn-clean-cache')?.addEventListener('click', () => cleanCache());

    // ── MODAL STATISTIQUES ────────────────────────────────────
    document.getElementById('btn-close-stats')?.addEventListener('click', () => closeStatsModal());

    // ── MODAL MONDES ─────────────────────────────────────────
    document.getElementById('btn-close-import-mc')?.addEventListener('click', () => { window.closeModal('modal-import-mc'); });
    document.getElementById('btn-open-import-mc')?.addEventListener('click', () => openImportMCWorldsModal());
    document.getElementById('btn-open-dir-root')?.addEventListener('click', () => openDir(''));
    document.getElementById('btn-open-dir-saves')?.addEventListener('click', () => openDir('saves'));
    document.getElementById('btn-open-dir-backups')?.addEventListener('click', () => openDir('backups'));
    document.getElementById('btn-close-worlds')?.addEventListener('click', () => closeWorldsModal());
    document.getElementById('btn-close-restore')?.addEventListener('click', () => { window.closeModal('modal-restore'); });

    // ── GALERIE SCREENSHOTS ───────────────────────────────────
    document.getElementById('btn-open-dir-root-gallery')?.addEventListener('click', () => openDir(''));
    document.getElementById('btn-open-dir-screenshots')?.addEventListener('click', () => openDir('screenshots'));
    document.getElementById('btn-close-gallery')?.addEventListener('click', () => closeGalleryModal());

    // ── CATALOGUE ─────────────────────────────────────────────
    document.getElementById('btn-search-catalog')?.addEventListener('click', () => searchGlobalCatalog());
    document.getElementById('btn-close-catalog')?.addEventListener('click', () => closeCatalogModal());

    // ── MODAL NOUVELLE INSTANCE ───────────────────────────────
    document.getElementById('btn-close-instance-modal')?.addEventListener('click', () => closeInstanceModal());
    document.getElementById('btn-save-instance')?.addEventListener('click', () => saveInstance());

    // ── PARAMÈTRES GLOBAUX ────────────────────────────────────
    document.getElementById('tab-btn-glob-gen')?.addEventListener('click', () => switchTabGlob('tab-glob-gen'));
    document.getElementById('tab-btn-glob-app')?.addEventListener('click', () => switchTabGlob('tab-glob-app'));
    document.getElementById('tab-btn-glob-updates')?.addEventListener('click', () => switchTabGlob('tab-glob-updates'));
    document.getElementById('tab-btn-glob-java')?.addEventListener('click', () => switchTabGlob('tab-glob-java'));
    document.getElementById('tab-btn-glob-horizon')?.addEventListener('click', () => switchTabGlob('tab-glob-horizon'));
    document.getElementById('btn-reconnect-discord')?.addEventListener('click', () => window.reconnectDiscord());
    document.getElementById('btn-scan-java')?.addEventListener('click', () => scanJavaVersions());
    document.getElementById('btn-custom-java-browse')?.addEventListener('click', () => document.getElementById('custom-java-file').click());
    document.getElementById('btn-save-default-options')?.addEventListener('click', () => saveDefaultOptions());
    document.getElementById('btn-save-default-servers')?.addEventListener('click', () => saveDefaultServers());
    document.getElementById('btn-bg-upload')?.addEventListener('click', () => document.getElementById('bg-upload').click());
    document.getElementById('btn-clear-bg')?.addEventListener('click', () => { document.getElementById('global-bg-path').value = ''; });
    document.getElementById('btn-start-update')?.addEventListener('click', () => startLauncherUpdate());
    document.getElementById('btn-check-launcher')?.addEventListener('click', () => checkLauncherUpdates());
    // Les boutons btn-dl-java-* sont gérés dynamiquement par SettingsUI.updateJavaButtonsDisplay() via btn.onclick.
    // NE PAS ajouter addEventListener ici (conflits double-déclenchement).
    document.getElementById('btn-close-global-settings')?.addEventListener('click', () => closeGlobalSettings());
    document.getElementById('btn-save-global-settings')?.addEventListener('click', () => saveGlobalSettings());

    // ── MODAL ÉDITION D'INSTANCE ──────────────────────────────
    document.getElementById('tab-btn-general')?.addEventListener('click', () => switchTab('tab-general'));
    document.getElementById('tab-btn-mods')?.addEventListener('click', () => switchTab('tab-mods'));
    document.getElementById('tab-btn-shaders')?.addEventListener('click', () => switchTab('tab-shaders'));
    document.getElementById('tab-btn-resourcepacks')?.addEventListener('click', () => switchTab('tab-resourcepacks'));
    document.getElementById('tab-btn-servers')?.addEventListener('click', () => switchTab('tab-servers'));
    document.getElementById('tab-btn-backups')?.addEventListener('click', () => switchTab('tab-backups'));
    document.getElementById('tab-btn-java')?.addEventListener('click', () => switchTab('tab-java'));
    document.getElementById('tab-btn-notes')?.addEventListener('click', () => switchTab('tab-notes'));
    document.getElementById('btn-edit-icon-upload')?.addEventListener('click', () => document.getElementById('edit-icon-upload').click());
    document.getElementById('btn-open-icon-gallery')?.addEventListener('click', () => openIconGallery());
    document.getElementById('btn-force-inject-options')?.addEventListener('click', () => forceInjectOptions());
    document.getElementById('btn-check-mod-updates')?.addEventListener('click', () => checkModUpdates());
    document.getElementById('btn-open-dir-mods')?.addEventListener('click', () => openDir('mods'));
    document.getElementById('btn-open-catalog-mods')?.addEventListener('click', () => { closeEditModal(); document.getElementById('catalog-type').value = 'mod'; openCatalogModal(); });
    document.getElementById('btn-open-dir-shaderpacks')?.addEventListener('click', () => openDir('shaderpacks'));
    document.getElementById('btn-open-catalog-shaders')?.addEventListener('click', () => { closeEditModal(); document.getElementById('catalog-type').value = 'shader'; openCatalogModal(); });
    document.getElementById('btn-open-dir-resourcepacks')?.addEventListener('click', () => openDir('resourcepacks'));
    document.getElementById('btn-open-catalog-resourcepacks')?.addEventListener('click', () => { closeEditModal(); document.getElementById('catalog-type').value = 'resourcepack'; openCatalogModal(); });
    document.getElementById('btn-add-server')?.addEventListener('click', () => addServer());
    document.getElementById('btn-open-dir-backups-edit')?.addEventListener('click', () => openDir('backups'));
    document.getElementById('btn-scan-java-edit')?.addEventListener('click', () => scanJavaVersions());
    document.getElementById('btn-custom-edit-java-browse')?.addEventListener('click', () => document.getElementById('custom-edit-java-file').click());
    document.getElementById('btn-close-edit-modal')?.addEventListener('click', () => closeEditModal());
    document.getElementById('btn-save-edit')?.addEventListener('click', () => saveEdit());

    // ── DEVICE LOGIN MICROSOFT ───────────────────────────────
    document.getElementById('ms-device-btn-copy')?.addEventListener('click', () => copyMsDeviceCode());
    document.getElementById('ms-device-btn-open')?.addEventListener('click', () => openMsDevicePage());
    document.getElementById('ms-device-btn-cancel')?.addEventListener('click', () => cancelMsDeviceLogin());

    // ── MODAL SKIN ─────────────────────────────────────────────
    document.getElementById('btn-upload-skin')?.addEventListener('click', () => document.getElementById('skin-upload').click());
    document.getElementById('btn-export-skin')?.addEventListener('click', () => exportSkin());
    document.getElementById('btn-skin-mojang-upload')?.addEventListener('click', () => document.getElementById('skin-mojang-input').click());
    document.getElementById('btn-close-skin-modal')?.addEventListener('click', () => closeSkinModal());

    // ── MODAL EXPORT ──────────────────────────────────────────
    document.getElementById('btn-export-zip-light')?.addEventListener('click', () => doExport('zip_light'));
    document.getElementById('btn-export-zip-full')?.addEventListener('click', () => doExport('zip_full'));
    document.getElementById('btn-close-export-modal')?.addEventListener('click', () => { window.closeModal('modal-export'); });

    // ── MODAL CRASH ───────────────────────────────────────────
    document.getElementById('btn-copy-crash-log')?.addEventListener('click', () => copyCrashLog());
    document.getElementById('btn-close-crash-modal')?.addEventListener('click', () => { window.closeModal('modal-crash'); });

    // ── GALERIE D'ICÔNES ──────────────────────────────────────
    document.getElementById('btn-close-icon-gallery')?.addEventListener('click', () => { window.closeModal('modal-icon-gallery'); });

    // ── BUILDER MODPACK ───────────────────────────────────────
    document.getElementById('btn-build-modpack')?.addEventListener('click', () => buildModpack());
    document.getElementById('btn-close-builder-modal')?.addEventListener('click', () => closeBuilderModal());

    // ── MENU CONTEXTUEL ───────────────────────────────────────
    document.getElementById('ctx-cloud-import')?.addEventListener('click', () => ctxSyncCloud());
    document.getElementById('ctx-cloud-upload')?.addEventListener('click', () => ctxUploadCloud());
    document.getElementById('ctx-folder')?.addEventListener('click', () => ctxFolder());
    document.getElementById('ctx-edit')?.addEventListener('click', () => ctxEdit());
    document.getElementById('ctx-create-shortcut')?.addEventListener('click', () => ctxShortcut());
    document.getElementById('ctx-delete-shortcut')?.addEventListener('click', () => ctxDeleteShortcut());
    document.getElementById('ctx-delete')?.addEventListener('click', () => ctxDelete());
    document.getElementById('ctx-cloud-restore-item')?.addEventListener('click', () => ctxRestoreCloud());
    document.getElementById('ctx-cloud-sync-item')?.addEventListener('click', () => ctxSyncCloudFromMenu());
    document.getElementById('ctx-cloud-upload-item')?.addEventListener('click', () => ctxUploadCloudFromMenu());
    document.getElementById('ctx-delete-cloud-only')?.addEventListener('click', () => ctxDeleteCloudOnly());

    // ── AUTO-LANCEMENT ────────────────────────────────────────
    document.getElementById('auto-crash-banner')?.addEventListener('click', () => window.openLastCrashReport());
    document.getElementById('auto-cancel-btn')?.addEventListener('click', () => window.cancelAutoLaunch());

    // ── FORMULAIRES — onchange / oninput ─────────────────────────────
    // Recherche + tri instances
    document.getElementById('account-dropdown')?.addEventListener('change', () => changeAccount());
    document.getElementById('search-bar')?.addEventListener('input', () => scheduleSearch());
    document.getElementById('sort-dropdown')?.addEventListener('change', () => renderUI());

    // Nouvelle instance — sélection version
    document.getElementById('check-beta')?.addEventListener('change', (e) => updateVersionList(e.target.checked));
    document.getElementById('new-version')?.addEventListener('change', () => updateLoaderVersions());
    document.getElementById('new-loader')?.addEventListener('change', () => updateLoaderVersions());

    // Nouvelle instance — RAM sliders (synchronisation input ↔ range)
    document.getElementById('new-ram-input')?.addEventListener('input', (e) => {
        const s = document.getElementById('new-ram-slider'); if (s) s.value = e.target.value;
    });
    document.getElementById('new-ram-slider')?.addEventListener('input', (e) => {
        const i = document.getElementById('new-ram-input'); if (i) i.value = e.target.value;
    });

    // Paramètres globaux — langue
    document.getElementById('global-lang')?.addEventListener('change', (e) => changeLanguage(e.target.value));

    // Paramètres globaux — RAM sliders
    document.getElementById('global-ram-input')?.addEventListener('input', (e) => {
        const s = document.getElementById('global-ram-slider'); if (s) s.value = e.target.value;
    });
    document.getElementById('global-ram-slider')?.addEventListener('input', (e) => {
        const i = document.getElementById('global-ram-input'); if (i) i.value = e.target.value;
    });

    // Paramètres globaux — Java custom file
    document.getElementById('custom-java-file')?.addEventListener('change', (e) => addCustomJava(e.target, 'global-java'));

    // Paramètres globaux — fond d'écran
    document.getElementById('bg-upload')?.addEventListener('change', (e) => {
        const p = document.getElementById('global-bg-path');
        if (p && e.target.files[0]) p.value = window.api.getFilePath(e.target.files[0]);
    });

    // Édition instance — version & loader
    document.getElementById('edit-mc-version')?.addEventListener('change', () => updateEditLoaderVersions());
    document.getElementById('edit-show-snapshots')?.addEventListener('change', () => toggleEditSnapshots());
    document.getElementById('edit-loader-type')?.addEventListener('change', () => updateEditLoaderVersions());

    // Édition instance — RAM sliders
    document.getElementById('edit-ram-input')?.addEventListener('input', (e) => {
        const s = document.getElementById('edit-ram-slider'); if (s) s.value = e.target.value;
    });
    document.getElementById('edit-ram-slider')?.addEventListener('input', (e) => {
        const i = document.getElementById('edit-ram-input'); if (i) i.value = e.target.value;
    });

    // Édition instance — recherche mods locaux
    document.getElementById('local-mod-search')?.addEventListener('input', () => filterLocalMods());

    // Édition instance — Java custom file
    document.getElementById('custom-edit-java-file')?.addEventListener('change', (e) => addCustomJava(e.target, 'edit-javapath'));

    // Édition instance — profil JVM
    document.getElementById('edit-jvm-profile')?.addEventListener('change', () => updateJvmDesc());

    // Modal skin
    document.getElementById('skin-upload')?.addEventListener('change', (e) => previewLocalSkin(e.target));
    document.getElementById('edit-icon-upload')?.addEventListener('change', (e) => previewInstanceIcon(e.target));
    document.getElementById('skin-variant-select')?.addEventListener('change', (e) => updateSkinVariantPreview(e.target));
    document.getElementById('skin-mojang-input')?.addEventListener('change', (e) => uploadSkinToMojang(e.target));

    // Builder modpack
    document.getElementById('builder-version')?.addEventListener('change', () => searchBuilderMods());
    document.getElementById('builder-loader')?.addEventListener('change', () => searchBuilderMods());
    document.getElementById('builder-type')?.addEventListener('change', () => searchBuilderMods());
    document.getElementById('builder-search')?.addEventListener('input', () => scheduleBuilderSearch());

    // ── TOUCHES ENTRÉE — champs texte ─────────────────────────────────
    document.getElementById('acc-name')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveOfflineAccount(); });
    document.getElementById('catalog-search')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchGlobalCatalog(); });
    document.getElementById('new-server-ip')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addServer(); });

    // ── EFFETS HOVER export-card (remplace onmouseover/onmouseout) ──────
    document.querySelectorAll('.export-card').forEach(card => {
        card.addEventListener('mouseenter', () => { card.style.borderColor = 'var(--accent)'; });
        card.addEventListener('mouseleave', () => { card.style.borderColor = 'var(--border)'; });
    });

});
