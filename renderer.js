const { Client } = require('minecraft-launcher-core');
const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const launcher = new Client();

const instanceFile = path.join(__dirname, 'instances.json');
const accountFile = path.join(__dirname, 'accounts.json');

const defaultIcons = {
    vanilla: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%2317B139'/%3E%3Crect x='1' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='5' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='3' y='4' width='2' height='3' fill='%23000'/%3E%3Crect x='2' y='5' width='1' height='2' fill='%23000'/%3E%3Crect x='5' y='5' width='1' height='2' fill='%23000'/%3E%3C/svg%3E", // Tête de Creeper
    forge: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%232b2b2b'/%3E%3Cpath d='M3 4h10v3H3zM6 7h4v2H6zM4 9h8v2H4zM2 11h12v3H2z' fill='%238c8c8c'/%3E%3Cpath d='M3 4h10v1H3zM6 7h4v1H6zM4 9h8v1H4zM2 11h12v1H2z' fill='%23a6a6a6'/%3E%3C/svg%3E", // L'Enclume
    fabric: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23e2d4b7'/%3E%3Cpath d='M0 4h16v2H0zM0 10h16v2H0zM4 0h2v16H4zM10 0h2v16H10z' fill='%23c8b593'/%3E%3C/svg%3E" // Motif de Tissu
};

let allInstances = [], allAccounts = [];
let selectedInstanceIdx = null, selectedAccountIdx = null;

document.addEventListener('DOMContentLoaded', () => init());

async function init() {
    loadStorage();
    try {
        const res = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
        const data = await res.json();
        const select = document.getElementById('new-version');
        data.versions.filter(v => v.type === "release").slice(0, 80).forEach(v => {
            let opt = document.createElement('option');
            opt.value = v.id; opt.innerHTML = v.id;
            select.appendChild(opt);
        });
    } catch (e) { console.error("API Mojang hors-ligne"); }
}

function loadStorage() {
    if (fs.existsSync(instanceFile)) allInstances = JSON.parse(fs.readFileSync(instanceFile));
    
    if (fs.existsSync(accountFile)) {
        let accData = JSON.parse(fs.readFileSync(accountFile));
        if (Array.isArray(accData)) {
            allAccounts = accData; 
        } else {
            allAccounts = accData.list || [];
            selectedAccountIdx = accData.lastUsed !== undefined ? accData.lastUsed : null;
        }
    }
    renderUI();
}

function saveAccountsToDisk() {
    fs.writeFileSync(accountFile, JSON.stringify({ list: allAccounts, lastUsed: selectedAccountIdx }, null, 2));
}

function renderUI() {
    const grid = document.getElementById('instance-grid');
    grid.innerHTML = "";
    
    allInstances.forEach((inst, i) => {
        const active = selectedInstanceIdx === i ? 'active' : '';
        let iconPath = inst.icon;
        let displaySrc = "";

        if (!iconPath || !fs.existsSync(iconPath)) {
            displaySrc = defaultIcons[inst.loader] || defaultIcons.vanilla;
        } else {
            displaySrc = 'file:///' + iconPath.replace(/\\/g, '/');
        }
        
        grid.innerHTML += `
        <div class="instance-card ${active}" onclick="selectInstance(${i})">
            <img src="${displaySrc}" class="instance-icon" style="background: ${displaySrc.startsWith('data') ? 'transparent' : '#111'};">
            <div class="instance-name">${inst.name}</div>
            <div class="instance-version">${inst.version} ${inst.loader === 'vanilla' ? '' : '('+inst.loader+')'}</div>
        </div>`;
    });

    const accDropdown = document.getElementById('account-dropdown');
    accDropdown.innerHTML = `<option value="">-- Choisir un compte --</option>`;
    allAccounts.forEach((acc, i) => {
        const isSelected = selectedAccountIdx === i ? 'selected' : '';
        accDropdown.innerHTML += `<option value="${i}" ${isSelected}>👤 ${acc.name}</option>`;
    });

    updateLaunchButton();
}

window.selectInstance = (i) => {
    selectedInstanceIdx = i;
    const inst = allInstances[i];
    
    const panel = document.getElementById('action-panel');
    panel.style.opacity = "1"; panel.style.pointerEvents = "auto";
    document.getElementById('panel-title').innerText = inst.name;
    document.getElementById('btn-mods').style.display = (inst.loader === 'vanilla') ? 'none' : 'block';

    updateLaunchButton();
    renderUI();
};

window.changeAccount = () => {
    const dropdown = document.getElementById('account-dropdown');
    selectedAccountIdx = dropdown.value === "" ? null : parseInt(dropdown.value);
    saveAccountsToDisk(); // Mémorise ton choix immédiatement !
    updateLaunchButton();
};

function updateLaunchButton() {
    const btn = document.getElementById('launch-btn');
    btn.disabled = (selectedInstanceIdx === null || selectedAccountIdx === null);
}

window.openDir = (folder) => {
    const inst = allInstances[selectedInstanceIdx];
    const safeName = inst.name.replace(/[^a-z0-9]/gi, '_');
    const dir = path.join(__dirname, 'instances', safeName, folder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
};

const getModal = (id) => document.getElementById(id);
window.openInstanceModal = () => getModal('modal-instance').style.display = 'flex';
window.closeInstanceModal = () => getModal('modal-instance').style.display = 'none';
window.openAccountModal = () => getModal('modal-account').style.display = 'flex';
window.closeAccountModal = () => getModal('modal-account').style.display = 'none';

window.openEditModal = () => {
    const inst = allInstances[selectedInstanceIdx];
    document.getElementById('edit-name').value = inst.name;
    document.getElementById('edit-ram').value = inst.ram;
    document.getElementById('edit-icon').value = "";
    getModal('modal-edit').style.display = 'flex';
};
window.closeEditModal = () => getModal('modal-edit').style.display = 'none';

window.saveInstance = () => {
    const name = document.getElementById('new-name').value;
    const version = document.getElementById('new-version').value;
    const loader = document.getElementById('new-loader').value;
    const ram = document.getElementById('new-ram').value || "4";
    if(!name) return;
    const cleanRam = ram.toString().replace(/[^\d]/g, ''); 
    allInstances.push({ name, version, loader, ram: cleanRam, icon: "" });
    fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
    renderUI(); closeInstanceModal();
};

window.saveEdit = () => {
    const inst = allInstances[selectedInstanceIdx];
    const newName = document.getElementById('edit-name').value;
    const newRam = document.getElementById('edit-ram').value;
    const iconFile = document.getElementById('edit-icon').files[0];
    
    if (newName) inst.name = newName;
    if (newRam) inst.ram = newRam.toString().replace(/[^\d]/g, '');
    if (iconFile && iconFile.path) inst.icon = iconFile.path;

    fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
    renderUI(); closeEditModal();
};

window.saveAccount = () => {
    const name = document.getElementById('acc-name').value;
    if(!name) return;
    allAccounts.push({ name });
    selectedAccountIdx = allAccounts.length - 1; 
    saveAccountsToDisk();
    renderUI(); closeAccountModal();
};

window.deleteInstance = () => {
    if(confirm("Supprimer l'instance ? (Fichiers locaux conservés)")) {
        allInstances.splice(selectedInstanceIdx, 1);
        fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
        selectedInstanceIdx = null;
        
        const panel = document.getElementById('action-panel');
        panel.style.opacity = "0.3"; panel.style.pointerEvents = "none";
        document.getElementById('panel-title').innerText = "Aucune instance";
        renderUI();
    }
};

document.getElementById('launch-btn').addEventListener('click', async () => {
    const inst = allInstances[selectedInstanceIdx];
    const acc = allAccounts[selectedAccountIdx];
    const statusText = document.getElementById('status-text');
    const bar = document.getElementById('progress-bar');
    const launchBtn = document.getElementById('launch-btn');

    const safeName = inst.name.replace(/[^a-z0-9]/gi, '_');
    const instancePath = path.resolve(__dirname, 'instances', safeName);
    const finalRam = inst.ram.toString().replace(/[^\d]/g, '');

    if (!fs.existsSync(instancePath)) fs.mkdirSync(instancePath, { recursive: true });

    let opts = {
        authorization: { access_token: "null", client_token: "null", uuid: "null", name: acc.name, user_properties: "{}" },
        root: instancePath,
        version: { number: inst.version, type: "release" },
        memory: { max: finalRam + "G", min: "1G" },
        customArgs: ["-XX:-UseAdaptiveSizePolicy", "-XX:-OmitStackTraceInFastThrow"]
    };

    statusText.innerText = "Préparation...";
    launchBtn.disabled = true;

    if (inst.loader === "fabric") {
        try {
            const fbRes = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${inst.version}`);
            const fbData = await fbRes.json();
            if(fbData.length > 0) opts.version.custom = `fabric-loader-${fbData[0].loader.version}-${inst.version}`;
        } catch(e) { console.error("Fabric Error", e); }
    }

    if (inst.loader === "forge") {
        statusText.innerText = "Recherche de Forge...";
        try {
            const forgeRes = await fetch(`https://bmclapi2.bangbang93.com/forge/minecraft/${inst.version}`);
            const forgeData = await forgeRes.json();
            if (forgeData && forgeData.length > 0) {
                const forgeBuild = forgeData[0].version; 
                const installerName = `forge-${inst.version}-${forgeBuild}-installer.jar`;
                const installerPath = path.join(instancePath, installerName);

                if (!fs.existsSync(installerPath)) {
                    statusText.innerText = "Téléchargement de Forge...";
                    const jarRes = await fetch(`https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/${inst.version}-${forgeBuild}/${installerName}`);
                    const arrayBuffer = await jarRes.arrayBuffer();
                    fs.writeFileSync(installerPath, Buffer.from(arrayBuffer));
                }
                opts.forge = installerPath;
            }
        } catch(e) { console.error("Forge Error", e); }
    }

    try {
        launcher.launch(opts);
        
        launcher.on('progress', (e) => {
            if (e.total) {
                bar.style.width = Math.round((e.task/e.total)*100) + "%";
                statusText.innerText = `Téléchargement : ${e.type}`;
            }
        });

        launcher.on('close', (code) => {
            statusText.innerText = code === 0 ? "Jeu fermé." : "Crash (Code " + code + ")";
            launchBtn.disabled = false;
            bar.style.width = "0%";
        });

        launcher.on('error', (err) => {
            statusText.innerText = "Erreur de lancement.";
            launchBtn.disabled = false;
        });

    } catch (err) {
        statusText.innerText = "Crash avant lancement.";
        launchBtn.disabled = false;
    }
});