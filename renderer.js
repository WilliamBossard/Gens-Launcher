const { ipcRenderer } = require('electron');
const { Client } = require('minecraft-launcher-core');
const { shell } = require('electron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const DiscordRPC = require('discord-rpc');

const launcher = new Client();
const discordClientId = '1223633633633633633'; 

let rpc = new DiscordRPC.Client({ transport: 'ipc' });
let rpcReady = false;
rpc.login({ clientId: discordClientId }).then(() => { rpcReady = true; }).catch(() => {});

function updateRPC(details, state) {
    if(!rpcReady) return;
    try {
        rpc.setActivity({
            details: details,
            state: state,
            startTimestamp: new Date(),
            largeImageKey: 'logo',
            largeImageText: 'Gens Launcher',
            instance: false,
        });
    } catch(e) {}
}

function clearRPC() {
    if(!rpcReady) return;
    try { rpc.clearActivity(); } catch(e) {}
}

const dataDir = path.join(process.env.APPDATA, 'GensLauncher');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const instanceFile = path.join(dataDir, 'instances.json');
const accountFile = path.join(dataDir, 'accounts.json');
const settingsFile = path.join(dataDir, 'settings.json'); 
const instancesRoot = path.join(dataDir, 'instances');
if (!fs.existsSync(instancesRoot)) fs.mkdirSync(instancesRoot, { recursive: true });

const defaultIcons = {
    vanilla: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%2317B139'/%3E%3Crect x='1' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='5' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='3' y='4' width='2' height='3' fill='%23000'/%3E%3C/svg%3E",
    forge: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%232b2b2b'/%3E%3Cpath d='M3 4h10v3H3zM6 7h4v2H6zM4 9h8v2H4zM2 11h12v3H2z' fill='%238c8c8c'/%3E%3C/svg%3E",
    fabric: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23e2d4b7'/%3E%3Cpath d='M0 4h16v2H0zM0 10h16v2H0zM4 0h2v16H4zM10 0h2v16H10z' fill='%23c8b593'/%3E%3C/svg%3E"
};

let allInstances = [], allAccounts = [], rawVersions = [];
let globalSettings = { defaultRam: 4096, defaultJavaPath: "" };
let selectedInstanceIdx = null, selectedAccountIdx = null;
let isGameRunning = false;
let sessionStartTime = 0;

document.addEventListener('DOMContentLoaded', () => {
    try { document.getElementById('app-version').innerText = "v" + require('./package.json').version; } catch(e){}
    init();
});

async function init() {
    loadStorage();
    try {
        const res = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
        const data = await res.json();
        rawVersions = data.versions;
        updateVersionList(false);
    } catch (e) {}
}

window.updateVersionList = (showSnapshots) => {
    const select1 = document.getElementById('new-version');
    const select2 = document.getElementById('catalog-version');
    select1.innerHTML = "";
    select2.innerHTML = "";
    
    rawVersions.forEach(v => {
        if (showSnapshots || v.type === "release") {
            let opt1 = document.createElement('option');
            opt1.value = v.id;
            opt1.innerHTML = v.id;
            select1.appendChild(opt1);
            
            let opt2 = document.createElement('option');
            opt2.value = v.id;
            opt2.innerHTML = v.id;
            select2.appendChild(opt2);
        }
    });
};

function loadStorage() {
    if (fs.existsSync(settingsFile)) globalSettings = Object.assign(globalSettings, JSON.parse(fs.readFileSync(settingsFile)));
    if (fs.existsSync(instanceFile)) allInstances = JSON.parse(fs.readFileSync(instanceFile));
    if (fs.existsSync(accountFile)) {
        let accData = JSON.parse(fs.readFileSync(accountFile));
        allAccounts = accData.list || [];
        selectedAccountIdx = accData.lastUsed !== undefined ? accData.lastUsed : null;
    }
    renderUI();
}

function renderUI() {
    const grid = document.getElementById('instance-grid'); 
    grid.innerHTML = "";
    
    const search = document.getElementById('search-bar').value.toLowerCase();
    const sort = document.getElementById('sort-dropdown').value;

    let displayList = allInstances.map((inst, i) => ({ ...inst, originalIndex: i }));
    displayList = displayList.filter(inst => inst.name.toLowerCase().includes(search));
    displayList.sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name);
        if (sort === 'lastPlayed') return (b.lastPlayed || 0) - (a.lastPlayed || 0);
        if (sort === 'playTime') return (b.playTime || 0) - (a.playTime || 0);
    });

    displayList.forEach((inst) => {
        const active = selectedInstanceIdx === inst.originalIndex ? 'active' : '';
        let displaySrc = inst.icon || defaultIcons[inst.loader] || defaultIcons.vanilla;
        grid.innerHTML += `<div class="instance-card ${active}" onclick="selectInstance(${inst.originalIndex})"><img src="${displaySrc}" class="instance-icon"><div class="instance-name">${inst.name}</div><div class="instance-version">${inst.version}</div></div>`;
    });
    
    const accDropdown = document.getElementById('account-dropdown'); 
    accDropdown.innerHTML = `<option value="">-- Aucun Joueur --</option>`;
    allAccounts.forEach((acc, i) => {
        const isSelected = selectedAccountIdx === i ? 'selected' : '';
        accDropdown.innerHTML += `<option value="${i}" ${isSelected}>${acc.name}</option>`;
    });

    const activeSkin = document.getElementById('active-skin');
    if (selectedAccountIdx !== null && allAccounts[selectedAccountIdx]) {
        activeSkin.style.display = 'block';
        activeSkin.src = `https://mc-heads.net/avatar/${allAccounts[selectedAccountIdx].name}/20`;
    } else {
        activeSkin.style.display = 'none';
    }

    updateLaunchButton();
    renderAccountManager(); 
}

function renderAccountManager() {
    const list = document.getElementById('account-list'); list.innerHTML = "";
    if (allAccounts.length === 0) { list.innerHTML = "<div style='padding:15px; color:#888; text-align:center;'>Aucun profil enregistré.</div>"; return; }
    allAccounts.forEach((acc, i) => {
        const typeLabel = acc.type === 'microsoft' ? '<span style="color:#107c10; font-weight:bold;">Microsoft</span>' : '<span style="color:#888;">Hors-Ligne</span>';
        list.innerHTML += `<div class="account-item"><div style="display: flex; align-items: center; gap: 10px;"><img src="https://mc-heads.net/avatar/${acc.name}/32" class="account-skin"><div><div style="color: white; font-weight: bold;">${acc.name}</div><div style="font-size: 0.7rem;">${typeLabel}</div></div></div><button class="btn-secondary" style="color: #f87171; border-color: #f87171; padding: 4px 8px;" onclick="deleteAccount(${i})">Supprimer</button></div>`;
    });
}

function renderModsManager() {
    const modsListDiv = document.getElementById('mods-list');
    modsListDiv.innerHTML = "";
    const inst = allInstances[selectedInstanceIdx];
    if(!inst) return;
    const modsPath = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, '_'), 'mods');
    if (!fs.existsSync(modsPath)) fs.mkdirSync(modsPath, { recursive: true });
    const files = fs.readdirSync(modsPath);
    let hasMods = false;

    files.forEach(file => {
        if (file.endsWith('.jar') || file.endsWith('.jar.disabled')) {
            hasMods = true;
            const isEnabled = !file.endsWith('.disabled');
            const displayName = file.replace('.jar.disabled', '.jar');
            const color = isEnabled ? 'var(--text-light)' : '#666';
            const decoration = isEnabled ? 'none' : 'line-through';
            modsListDiv.innerHTML += `<div class="mod-item"><span style="color: ${color}; text-decoration: ${decoration};">${displayName}</span><input type="checkbox" ${isEnabled ? 'checked' : ''} onchange="toggleMod('${file}', this.checked)"></div>`;
        }
    });

    if (!hasMods) modsListDiv.innerHTML = "<div style='padding:15px; color:#888; text-align:center;'>Aucun mod local installé.</div>";
}

window.toggleMod = (filename, isEnabled) => {
    const inst = allInstances[selectedInstanceIdx];
    const modsPath = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, '_'), 'mods');
    const oldPath = path.join(modsPath, filename);
    const newName = isEnabled ? filename.replace('.disabled', '') : filename + '.disabled';
    const newPath = path.join(modsPath, newName);
    fs.renameSync(oldPath, newPath);
    renderModsManager(); 
};

window.openCatalogModal = () => {
    document.getElementById('catalog-status').innerText = "";
    if (selectedInstanceIdx !== null) {
        const inst = allInstances[selectedInstanceIdx];
        if (inst.loader !== 'vanilla') {
            document.getElementById('catalog-loader').value = inst.loader;
        }
        document.getElementById('catalog-version').value = inst.version;
    }
    document.getElementById('modal-catalog').style.display = 'flex';
    searchGlobalCatalog(); 
};
window.closeCatalogModal = () => document.getElementById('modal-catalog').style.display = 'none';

window.searchGlobalCatalog = async () => {
    const query = document.getElementById('catalog-search').value;
    const loader = document.getElementById('catalog-loader').value;
    const version = document.getElementById('catalog-version').value;
    const resDiv = document.getElementById('catalog-results');
    
    resDiv.innerHTML = "<div style='text-align:center; padding: 20px;'>Chargement du catalogue...</div>";
    
    try {
        const facets = `[["categories:${loader}"],["versions:${version}"]]`;
        const sortIndex = query ? 'relevance' : 'downloads';
        const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}&index=${sortIndex}&limit=20`;
        
        const res = await fetch(url);
        const data = await res.json();
        
        resDiv.innerHTML = "";
        if(data.hits.length === 0) {
            resDiv.innerHTML = "<div style='text-align:center; padding: 20px;'>Aucun mod compatible trouvé.</div>";
            return;
        }
        
        data.hits.forEach(mod => {
            const downloads = (mod.downloads / 1000000).toFixed(1) + "M DLs";
            resDiv.innerHTML += `
                <div class="catalog-card">
                    <img src="${mod.icon_url || ''}" style="width: 50px; height: 50px; border-radius: 6px; background: #333;">
                    <div style="flex-grow: 1; display: flex; flex-direction: column;">
                        <div style="font-weight: bold; color: var(--text-light); font-size: 0.95rem;">${mod.title}</div>
                        <div style="font-size: 0.75rem; color: #aaa; margin-bottom: 5px;">${mod.author || 'Auteur'} • ${downloads}</div>
                        <div style="font-size: 0.8rem; color: var(--text-main);">${mod.description}</div>
                    </div>
                    <button class="btn-primary" onclick="installGlobalMod('${mod.project_id}', false)">Installer</button>
                </div>
            `;
        });
    } catch(e) {
        resDiv.innerHTML = "<div style='text-align:center; padding: 20px; color:#f87171;'>Erreur de connexion.</div>";
    }
};

window.installGlobalMod = async (projectId, isDependency = false) => {
    if (selectedInstanceIdx === null) return;
    
    const inst = allInstances[selectedInstanceIdx];
    const statusText = document.getElementById('catalog-status');
    const loader = document.getElementById('catalog-loader') ? document.getElementById('catalog-loader').value : (inst.loader === 'forge' ? 'forge' : 'fabric');
    const version = document.getElementById('catalog-version') ? document.getElementById('catalog-version').value : inst.version;
    
    try {
        if(!isDependency) statusText.innerText = "Téléchargement du mod en cours...";
        const url = `https://api.modrinth.com/v2/project/${projectId}/version?loaders=["${loader}"]&game_versions=["${version}"]`;
        const res = await fetch(url);
        const versions = await res.json();
        
        if(versions.length === 0) {
            if(!isDependency) statusText.innerText = "Aucun fichier compatible trouvé pour cette version.";
            return;
        }
        
        const fileData = versions[0];
        const file = fileData.files.find(f => f.primary) || fileData.files[0];
        const modsPath = path.join(instancesRoot, inst.name.replace(/[^a-z0-9]/gi, '_'), 'mods');
        if (!fs.existsSync(modsPath)) fs.mkdirSync(modsPath, { recursive: true });
        
        const filePath = path.join(modsPath, file.filename);
        if (!fs.existsSync(filePath)) {
            const fileRes = await fetch(file.url);
            const buffer = await fileRes.arrayBuffer();
            fs.writeFileSync(filePath, Buffer.from(buffer));
        }

        if (fileData.dependencies && fileData.dependencies.length > 0) {
            for (let dep of fileData.dependencies) {
                if (dep.dependency_type === 'required') {
                    let depId = dep.project_id || dep.version_id;
                    if (depId) {
                        statusText.innerText = "Téléchargement des dépendances...";
                        await installGlobalMod(depId, true);
                    }
                }
            }
        }
        
        if(!isDependency) {
            statusText.innerText = `Mod installé avec succès avec ses dépendances !`;
            setTimeout(() => statusText.innerText = "", 4000);
            const searchInput = document.getElementById('modrinth-search');
            if(searchInput) searchInput.value = "";
            renderModsManager();
        }
    } catch(e) {
        if(!isDependency) statusText.innerText = "Erreur lors du téléchargement.";
    }
};

window.scanJavaVersions = () => {
    document.getElementById('status-text').innerText = "Recherche de Java...";
    const datalist = document.getElementById('java-paths-list');
    datalist.innerHTML = "";
    
    const basePaths = [
        'C:\\Program Files\\Java',
        'C:\\Program Files (x86)\\Java',
        'C:\\Program Files\\Eclipse Adoptium',
        'C:\\Program Files\\Amazon Corretto'
    ];
    
    let found = 0;
    for (let bp of basePaths) {
        if (fs.existsSync(bp)) {
            try {
                const dirs = fs.readdirSync(bp);
                for (let d of dirs) {
                    const jPath = path.join(bp, d, 'bin', 'javaw.exe');
                    if (fs.existsSync(jPath)) {
                        let opt = document.createElement('option');
                        opt.value = jPath;
                        datalist.appendChild(opt);
                        found++;
                    }
                }
            } catch(e) {}
        }
    }
    
    document.getElementById('status-text').innerText = `${found} version(s) de Java trouvée(s).`;
    setTimeout(() => document.getElementById('status-text').innerText = "Prêt", 3000);
    alert(`${found} version(s) de Java trouvée(s) sur votre PC.\nCliquez sur le champ 'Chemin Java' pour voir la liste !`);
};

document.getElementById('edit-icon-upload').addEventListener('change', function() {
    if (this.files && this.files[0]) {
        let reader = new FileReader();
        reader.onload = function(e) { document.getElementById('edit-icon-preview').src = e.target.result; }
        reader.readAsDataURL(this.files[0]);
    }
});

window.selectInstance = (i) => {
    selectedInstanceIdx = i;
    const inst = allInstances[i];
    document.getElementById('action-panel').style.opacity = "1";
    document.getElementById('action-panel').style.pointerEvents = "auto";
    document.getElementById('panel-title').innerText = inst.name;
    document.getElementById('btn-mods').style.display = (inst.loader === 'vanilla') ? 'none' : 'block';
    
    document.getElementById('panel-stats').style.display = 'block';
    let h = Math.floor((inst.playTime || 0) / 3600000);
    let m = Math.floor(((inst.playTime || 0) % 3600000) / 60000);
    document.getElementById('stat-time').innerText = `${h}h ${m}m`;
    document.getElementById('stat-last').innerText = inst.lastPlayed ? new Date(inst.lastPlayed).toLocaleDateString() : "Jamais";

    renderUI();
};

window.changeAccount = () => {
    const dropdown = document.getElementById('account-dropdown');
    selectedAccountIdx = dropdown.value === "" ? null : parseInt(dropdown.value);
    fs.writeFileSync(accountFile, JSON.stringify({ list: allAccounts, lastUsed: selectedAccountIdx }, null, 2));
    renderUI();
};

function updateLaunchButton() {
    const btn = document.getElementById('launch-btn');
    if (isGameRunning) {
        btn.innerText = "Forcer l'arrêt";
        btn.style.background = "#f87171";
        btn.disabled = false;
        return;
    }
    btn.innerText = "Lancer";
    btn.style.background = "var(--accent)";
    btn.disabled = (selectedInstanceIdx === null || selectedAccountIdx === null);
}

function setUIState(running) {
    isGameRunning = running;
    document.getElementById('instance-grid').style.pointerEvents = running ? 'none' : 'auto';
    document.getElementById('instance-grid').style.opacity = running ? '0.5' : '1';
    
    const btns = ['btn-offline', 'btn-edit', 'btn-delete', 'btn-copy', 'btn-export'];
    btns.forEach(id => document.getElementById(id).disabled = running);
    
    updateLaunchButton();
}

document.getElementById('launch-btn').addEventListener('click', async () => {
    if (isGameRunning) {
        if (launcher && launcher.process) launcher.process.kill('SIGKILL');
        return;
    }

    const inst = allInstances[selectedInstanceIdx];
    const acc = allAccounts[selectedAccountIdx];
    const safeName = inst.name.replace(/[^a-z0-9]/gi, '_');
    const instancePath = path.join(instancesRoot, safeName);
    const progBar = document.getElementById('progress-bar');
    const logOutput = document.getElementById('log-output');

    document.getElementById('console-container').style.display = 'block';
    logOutput.innerHTML = `<span style="color:#007acc">[SYSTEM] Lancement de ${inst.name}...</span>\n`;

    let ramMB = inst.ram ? parseInt(inst.ram) : globalSettings.defaultRam;
    if (ramMB < 128) ramMB = ramMB * 1024; 

    let jPath = inst.javaPath && inst.javaPath.trim() !== "" ? inst.javaPath : (globalSettings.defaultJavaPath || "javaw");
    let customArgs = inst.jvmArgs && inst.jvmArgs.trim() !== "" ? inst.jvmArgs.split(" ") : [];
    
    let resW = inst.resW ? parseInt(inst.resW) : 854;
    let resH = inst.resH ? parseInt(inst.resH) : 480;

    document.getElementById('status-text').innerText = "Vérification de Java...";
    let javaToTest = jPath === "javaw" ? "java" : jPath;
    if (javaToTest.toLowerCase().endsWith('javaw.exe')) {
        javaToTest = javaToTest.substring(0, javaToTest.length - 9) + 'java.exe';
    } else if (javaToTest.toLowerCase().endsWith('javaw')) {
        javaToTest = javaToTest.substring(0, javaToTest.length - 5) + 'java';
    }

    const javaExists = await new Promise((resolve) => {
        exec(`"${javaToTest}" -version`, (err, stdout, stderr) => {
            if (err) {
                const errorStr = (err.message + stdout + stderr).toLowerCase();
                if (errorStr.includes('not recognized') || errorStr.includes('non reconnu') || errorStr.includes('introuvable') || err.code === 'ENOENT') resolve(false);
                else resolve(true); 
            } else resolve(true);
        });
    });

    if (!javaExists) {
        logOutput.insertAdjacentHTML('beforeend', `<br><span style="color:#f87171; font-weight:bold;">[ERREUR] Java n'est pas installé ou introuvable !</span><br>`);
        document.getElementById('status-text').innerText = "Erreur Java";
        alert("Java est introuvable sur votre ordinateur !\n\nPour jouer à Minecraft, vous devez installer Java (version 17 ou 21 recommandée).\nSi vous l'avez déjà installé, cliquez sur le bouton 'Scanner' dans les paramètres.");
        return;
    }

    let authObj = { access_token: "null", client_token: "null", uuid: "null", name: acc.name, user_properties: "{}" };
    if (acc.type === "microsoft" && acc.mclcAuth) {
        authObj = acc.mclcAuth;
    }

    let opts = {
        authorization: authObj,
        root: instancePath,
        version: { number: inst.version, type: "release" },
        memory: { max: ramMB + "M", min: "1024M" }, 
        javaPath: jPath,
        customArgs: customArgs,
        window: { width: resW, height: resH },
        spawnOptions: { detached: false, shell: false, windowsHide: true }
    };

    if (inst.loader === "fabric") {
        try {
            document.getElementById('status-text').innerText = "Installation de Fabric...";
            const fbRes = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${inst.version}`);
            const fbData = await fbRes.json();
            if(fbData.length > 0) {
                const lVer = fbData[0].loader.version;
                const customVerName = `fabric-loader-${lVer}-${inst.version}`;
                opts.version.custom = customVerName;
                const vPath = path.join(instancePath, 'versions', customVerName);
                if (!fs.existsSync(vPath)) fs.mkdirSync(vPath, { recursive: true });
                const jsonPath = path.join(vPath, `${customVerName}.json`);
                if (!fs.existsSync(jsonPath)) {
                    const response = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${inst.version}/${lVer}/profile/json`);
                    fs.writeFileSync(jsonPath, await response.text());
                }
            } else return;
        } catch(e) { return; }
    }

    document.getElementById('status-text').innerText = "Préparation des fichiers...";
    setUIState(true);
    sessionStartTime = Date.now();
    updateRPC(inst.name, "En jeu");

    launcher.launch(opts);
    launcher.on('progress', (e) => {
        let perc = 0; if (e.total > 0) perc = Math.round((e.task / e.total) * 100);
        progBar.style.width = perc + "%"; document.getElementById('status-text').innerText = `Téléchargement : ${perc}%`;
    });
    launcher.on('data', (data) => { logOutput.insertAdjacentHTML('beforeend', `<span>[GAME] ${data}</span><br>`); logOutput.scrollTop = logOutput.scrollHeight; });
    launcher.on('close', (code) => {
        logOutput.insertAdjacentHTML('beforeend', `<br><span style="color:red">[SYSTEM] Le jeu s'est arrêté</span><br>`);
        document.getElementById('status-text').innerText = "Prêt"; 
        progBar.style.width = "0%";
        setUIState(false);
        clearRPC();
        
        if (selectedInstanceIdx !== null) {
            allInstances[selectedInstanceIdx].playTime = (allInstances[selectedInstanceIdx].playTime || 0) + (Date.now() - sessionStartTime);
            allInstances[selectedInstanceIdx].lastPlayed = Date.now();
            fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
            selectInstance(selectedInstanceIdx);
        }
    });
});

window.switchTab = (tabId) => {
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-content').forEach(c => c.classList.remove('active'));
    const tabBtn = document.getElementById('tab-btn-' + tabId.replace('tab-', ''));
    if(tabBtn) tabBtn.classList.add('active');
    const tabContent = document.getElementById(tabId);
    if(tabContent) tabContent.classList.add('active');
    
    if(tabId === 'tab-mods') {
        renderModsManager();
    }
};

window.openGlobalSettings = () => {
    document.getElementById('global-ram-input').value = globalSettings.defaultRam;
    document.getElementById('global-ram-slider').value = globalSettings.defaultRam;
    document.getElementById('global-java').value = globalSettings.defaultJavaPath;
    document.getElementById('modal-settings').style.display = 'flex';
};
window.closeGlobalSettings = () => document.getElementById('modal-settings').style.display = 'none';
window.saveGlobalSettings = () => {
    globalSettings.defaultRam = parseInt(document.getElementById('global-ram-input').value);
    globalSettings.defaultJavaPath = document.getElementById('global-java').value;
    fs.writeFileSync(settingsFile, JSON.stringify(globalSettings, null, 2));
    closeGlobalSettings();
};

window.openInstanceModal = () => {
    document.getElementById('new-ram-input').value = globalSettings.defaultRam;
    document.getElementById('new-ram-slider').value = globalSettings.defaultRam;
    document.getElementById('modal-instance').style.display = 'flex';
};
window.closeInstanceModal = () => document.getElementById('modal-instance').style.display = 'none';

window.openEditModal = (targetTab = 'tab-general') => {
    const inst = allInstances[selectedInstanceIdx];
    let ramMB = inst.ram ? parseInt(inst.ram) : globalSettings.defaultRam;
    if (ramMB < 128) ramMB = ramMB * 1024; 

    document.getElementById('edit-modal-title').innerText = `Paramètres : ${inst.name}`;
    document.getElementById('edit-name').value = inst.name;
    document.getElementById('edit-ram-input').value = ramMB;
    document.getElementById('edit-ram-slider').value = ramMB;
    document.getElementById('edit-javapath').value = inst.javaPath || "";
    document.getElementById('edit-res-w').value = inst.resW || "";
    document.getElementById('edit-res-h').value = inst.resH || "";
    document.getElementById('edit-jvmargs').value = inst.jvmArgs || "";
    document.getElementById('edit-notes').value = inst.notes || "";
    document.getElementById('edit-icon-preview').src = inst.icon || defaultIcons[inst.loader] || defaultIcons.vanilla;
    
    const btnModsTab = document.getElementById('tab-btn-mods');
    if (inst.loader === 'vanilla') {
        btnModsTab.style.display = 'none';
        if (targetTab === 'tab-mods') targetTab = 'tab-general';
    } else {
        btnModsTab.style.display = 'block';
    }
    
    switchTab(targetTab);
    document.getElementById('modal-edit').style.display = 'flex';
};
window.closeEditModal = () => document.getElementById('modal-edit').style.display = 'none';

window.saveInstance = () => {
    const name = document.getElementById('new-name').value;
    const version = document.getElementById('new-version').value;
    const loader = document.getElementById('new-loader').value;
    const ram = document.getElementById('new-ram-input').value;
    if(!name) return;
    allInstances.push({ name, version, loader, ram: ram.toString(), javaPath: "", jvmArgs: "", notes: "", icon: "", resW: "", resH: "", playTime: 0, lastPlayed: 0 });
    fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
    renderUI(); closeInstanceModal();
};

window.saveEdit = () => {
    const inst = allInstances[selectedInstanceIdx];
    inst.name = document.getElementById('edit-name').value;
    inst.ram = document.getElementById('edit-ram-input').value;
    inst.javaPath = document.getElementById('edit-javapath').value;
    inst.resW = document.getElementById('edit-res-w').value;
    inst.resH = document.getElementById('edit-res-h').value;
    inst.jvmArgs = document.getElementById('edit-jvmargs').value;
    inst.notes = document.getElementById('edit-notes').value;
    
    const iconSrc = document.getElementById('edit-icon-preview').src;
    if(!iconSrc.includes('svg+xml')) inst.icon = iconSrc; 
    
    fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
    renderUI(); closeEditModal();
};

window.openAccountModal = () => { document.getElementById('acc-name').value = ""; document.getElementById('modal-account').style.display = 'flex'; };
window.closeAccountModal = () => document.getElementById('modal-account').style.display = 'none';

window.saveOfflineAccount = () => {
    const name = document.getElementById('acc-name').value.trim();
    if(!name) return;
    allAccounts.push({ type: "offline", name }); 
    selectedAccountIdx = allAccounts.length - 1;
    fs.writeFileSync(accountFile, JSON.stringify({ list: allAccounts, lastUsed: selectedAccountIdx }, null, 2));
    document.getElementById('acc-name').value = ""; renderUI(); 
};

window.loginMicrosoft = async () => {
    const btn = document.getElementById('btn-ms-login');
    const originalText = btn.innerText;
    btn.innerText = "Connexion en cours...";
    btn.disabled = true;

    try {
        const result = await ipcRenderer.invoke('login-microsoft');
        if (result.success) {
            const authObj = result.auth;
            allAccounts.push({
                type: "microsoft",
                name: authObj.name,
                uuid: authObj.uuid,
                mclcAuth: authObj
            });
            selectedAccountIdx = allAccounts.length - 1;
            fs.writeFileSync(accountFile, JSON.stringify({ list: allAccounts, lastUsed: selectedAccountIdx }, null, 2));
            renderUI();
            closeAccountModal();
        }
    } catch (e) {
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
};

window.deleteAccount = (index) => {
    if(confirm("Retirer ce compte ?")) {
        allAccounts.splice(index, 1);
        if (selectedAccountIdx === index) selectedAccountIdx = allAccounts.length > 0 ? 0 : null;
        else if (selectedAccountIdx > index) selectedAccountIdx--;
        fs.writeFileSync(accountFile, JSON.stringify({ list: allAccounts, lastUsed: selectedAccountIdx }, null, 2)); renderUI();
    }
};

window.openDir = (f) => {
    const dir = path.join(instancesRoot, allInstances[selectedInstanceIdx].name.replace(/[^a-z0-9]/gi, '_'), f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
};

window.copyInstance = () => {
    if(selectedInstanceIdx === null) return;
    const oldInst = allInstances[selectedInstanceIdx];
    let inst = JSON.parse(JSON.stringify(oldInst));
    
    let newName = inst.name + " - Copie";
    while(allInstances.some(i => i.name === newName)) newName += " (2)";
    
    inst.name = newName; 
    inst.playTime = 0; 
    inst.lastPlayed = 0;
    
    const safeOldName = oldInst.name.replace(/[^a-z0-9]/gi, '_');
    const safeNewName = inst.name.replace(/[^a-z0-9]/gi, '_');
    
    const oldPath = path.join(instancesRoot, safeOldName);
    const newPath = path.join(instancesRoot, safeNewName);
    
    if (fs.existsSync(oldPath)) fs.cpSync(oldPath, newPath, { recursive: true });
    
    allInstances.push(inst);
    fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2)); 
    renderUI();
};

window.deleteInstance = () => {
    if(confirm("Supprimer l'instance ?")) {
        allInstances.splice(selectedInstanceIdx, 1);
        fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
        selectedInstanceIdx = null; 
        document.getElementById('panel-stats').style.display = 'none';
        document.getElementById('action-panel').style.opacity = "0.4";
        document.getElementById('action-panel').style.pointerEvents = "none";
        document.getElementById('panel-title').innerText = "Sélectionnez une instance";
        renderUI();
    }
};

window.exportInstance = () => {
    if (selectedInstanceIdx === null) return;
    const inst = allInstances[selectedInstanceIdx];
    const safeName = inst.name.replace(/[^a-z0-9]/gi, '_');
    const sourceFolder = path.join(instancesRoot, safeName);
    const exportDir = path.join(dataDir, 'exports');
    if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
    
    const zipPath = path.join(exportDir, `${safeName}.zip`);
    const zip = new AdmZip();
    if (fs.existsSync(sourceFolder)) zip.addLocalFolder(sourceFolder, "files");
    
    zip.addFile("instance.json", Buffer.from(JSON.stringify(inst, null, 2), "utf8"));
    zip.writeZip(zipPath);
    shell.showItemInFolder(zipPath);
};

document.getElementById('import-upload').addEventListener('change', function(e) {
    if (!this.files || !this.files[0]) return;
    const zipPath = this.files[0].path;
    try {
        const zip = new AdmZip(zipPath);
        const metaEntry = zip.getEntry("instance.json");
        if (!metaEntry) { this.value = ''; return; }
        
        const meta = JSON.parse(zip.readAsText(metaEntry));
        let newName = meta.name;
        while (allInstances.some(i => i.name === newName)) newName += " (Importé)";
        
        meta.name = newName;
        meta.playTime = 0;
        meta.lastPlayed = 0;
        
        const safeName = meta.name.replace(/[^a-z0-9]/gi, '_');
        const destFolder = path.join(instancesRoot, safeName);
        if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });

        zip.getEntries().forEach(entry => {
            if (entry.entryName.startsWith("files/") && entry.entryName !== "files/") {
                const relPath = entry.entryName.substring(6);
                const targetPath = path.join(destFolder, relPath);
                if (entry.isDirectory) {
                    if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
                } else {
                    const dir = path.dirname(targetPath);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(targetPath, zip.readFile(entry));
                }
            }
        });

        allInstances.push(meta);
        fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
        renderUI();
    } catch (err) {}
    this.value = '';
});