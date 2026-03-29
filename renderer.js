const { Client } = require('minecraft-launcher-core');
const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const launcher = new Client();

// --- CONFIGURATION DES CHEMINS ---
const dataDir = path.join(process.env.APPDATA, 'GensLauncher');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const instanceFile = path.join(dataDir, 'instances.json');
const accountFile = path.join(dataDir, 'accounts.json');
const instancesRoot = path.join(dataDir, 'instances');
if (!fs.existsSync(instancesRoot)) fs.mkdirSync(instancesRoot, { recursive: true });

// LOGOS SVG
const defaultIcons = {
    vanilla: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%2317B139'/%3E%3Crect x='1' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='5' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='3' y='4' width='2' height='3' fill='%23000'/%3E%3C/svg%3E",
    forge: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%232b2b2b'/%3E%3Cpath d='M3 4h10v3H3zM6 7h4v2H6zM4 9h8v2H4zM2 11h12v3H2z' fill='%238c8c8c'/%3E%3C/svg%3E",
    fabric: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23e2d4b7'/%3E%3Cpath d='M0 4h16v2H0zM0 10h16v2H0zM4 0h2v16H4zM10 0h2v16H10z' fill='%23c8b593'/%3E%3C/svg%3E"
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
        data.versions.filter(v => v.type === "release").slice(0, 50).forEach(v => {
            let opt = document.createElement('option'); opt.value = v.id; opt.innerHTML = v.id; select.appendChild(opt);
        });
    } catch (e) { console.error("API Mojang Down"); }
}

function loadStorage() {
    if (fs.existsSync(instanceFile)) allInstances = JSON.parse(fs.readFileSync(instanceFile));
    if (fs.existsSync(accountFile)) {
        let accData = JSON.parse(fs.readFileSync(accountFile));
        allAccounts = accData.list || [];
        selectedAccountIdx = accData.lastUsed !== undefined ? accData.lastUsed : null;
    }
    renderUI();
}

function renderUI() {
    const grid = document.getElementById('instance-grid'); grid.innerHTML = "";
    allInstances.forEach((inst, i) => {
        const active = selectedInstanceIdx === i ? 'active' : '';
        let displaySrc = defaultIcons[inst.loader] || defaultIcons.vanilla;
        grid.innerHTML += `<div class="instance-card ${active}" onclick="selectInstance(${i})"><img src="${displaySrc}" class="instance-icon"><div>${inst.name}</div><div style="font-size:10px; color:#888;">${inst.version}</div></div>`;
    });
    const accDropdown = document.getElementById('account-dropdown'); accDropdown.innerHTML = `<option value="">-- Joueur --</option>`;
    allAccounts.forEach((acc, i) => {
        const isSelected = selectedAccountIdx === i ? 'selected' : '';
        accDropdown.innerHTML += `<option value="${i}" ${isSelected}>${acc.name}</option>`;
    });
    updateLaunchButton();
}

window.selectInstance = (i) => {
    selectedInstanceIdx = i;
    document.getElementById('action-panel').style.opacity = "1";
    document.getElementById('action-panel').style.pointerEvents = "auto";
    document.getElementById('panel-title').innerText = allInstances[i].name;
    document.getElementById('btn-mods').style.display = (allInstances[i].loader === 'vanilla') ? 'none' : 'block';
    renderUI();
};

window.changeAccount = () => {
    const dropdown = document.getElementById('account-dropdown');
    selectedAccountIdx = dropdown.value === "" ? null : parseInt(dropdown.value);
    fs.writeFileSync(accountFile, JSON.stringify({ list: allAccounts, lastUsed: selectedAccountIdx }, null, 2));
    updateLaunchButton();
};

function updateLaunchButton() {
    document.getElementById('launch-btn').disabled = (selectedInstanceIdx === null || selectedAccountIdx === null);
}

// --- LE MOTEUR DE LANCEMENT (VERSION ANTI-JAVA-WINDOW) ---
document.getElementById('launch-btn').addEventListener('click', async () => {
    const inst = allInstances[selectedInstanceIdx];
    const acc = allAccounts[selectedAccountIdx];
    const safeName = inst.name.replace(/[^a-z0-9]/gi, '_');
    const instancePath = path.join(instancesRoot, safeName);
    const progBar = document.getElementById('progress-bar');
    const logOutput = document.getElementById('log-output');

    document.getElementById('console-container').style.display = 'block';
    logOutput.innerHTML = `<span style="color:#007acc">[SYSTEM] Lancement du processus...</span>\n`;

    let opts = {
        authorization: { access_token: "null", client_token: "null", uuid: "null", name: acc.name, user_properties: "{}" },
        root: instancePath,
        version: { number: inst.version, type: "release" },
        memory: { max: (inst.ram || 4) + "G", min: "1G" },
        
        // --- SOLUTIONS POUR MASQUER LA CMD ET CAPTURER LES LOGS ---
        javaPath: "java", 
        overrides: {
            detached: false // Oblige Java à rester lié au launcher (Masque la CMD)
        }
    };

    if (inst.loader === "fabric") {
        try {
            const fbRes = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${inst.version}`);
            const fbData = await fbRes.json();
            if(fbData.length > 0) opts.version.custom = `fabric-loader-${fbData[0].loader.version}-${inst.version}`;
        } catch(e) { logOutput.innerHTML += "[ERROR] Fabric Meta fail\n"; }
    }

    document.getElementById('status-text').innerText = "VÉRIFICATION...";
    document.getElementById('launch-btn').disabled = true;

    // Lancement effectif
    launcher.launch(opts);

    // Événements de logs (Capture flux standard + erreur)
    launcher.on('debug', (data) => {
        logOutput.insertAdjacentHTML('beforeend', `<span style="color:#aaa">[DEBUG] ${data}</span><br>`);
        logOutput.scrollTop = logOutput.scrollHeight;
    });

    launcher.on('data', (data) => {
        logOutput.insertAdjacentHTML('beforeend', `<span>[GAME] ${data}</span><br>`);
        logOutput.scrollTop = logOutput.scrollHeight;
    });

    launcher.on('progress', (e) => {
        const perc = Math.round((e.task / e.total) * 100);
        progBar.style.width = perc + "%";
        document.getElementById('status-text').innerText = `CHARGEMENT: ${perc}%`;
    });

    launcher.on('close', (code) => {
        logOutput.insertAdjacentHTML('beforeend', `<br><span style="color:red">[SYSTEM] Fin du processus (Code ${code})</span><br>`);
        document.getElementById('status-text').innerText = "PRÊT.";
        document.getElementById('launch-btn').disabled = false;
        progBar.style.width = "0%";
    });
});

// MODALS
window.openInstanceModal = () => document.getElementById('modal-instance').style.display = 'flex';
window.closeInstanceModal = () => document.getElementById('modal-instance').style.display = 'none';
window.openAccountModal = () => document.getElementById('modal-account').style.display = 'flex';
window.closeAccountModal = () => document.getElementById('modal-account').style.display = 'none';
window.openEditModal = () => {
    document.getElementById('edit-ram').value = allInstances[selectedInstanceIdx].ram;
    document.getElementById('modal-edit').style.display = 'flex';
};
window.closeEditModal = () => document.getElementById('modal-edit').style.display = 'none';

window.saveInstance = () => {
    const name = document.getElementById('new-name').value;
    const version = document.getElementById('new-version').value;
    const loader = document.getElementById('new-loader').value;
    const ram = document.getElementById('new-ram').value || "4";
    if(!name) return;
    allInstances.push({ name, version, loader, ram: ram.toString(), icon: "" });
    fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
    renderUI(); closeInstanceModal();
};

window.saveEdit = () => {
    const newRam = document.getElementById('edit-ram').value;
    if (newRam) {
        allInstances[selectedInstanceIdx].ram = newRam.toString();
        fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
    }
    closeEditModal();
};

window.saveAccount = () => {
    const name = document.getElementById('acc-name').value;
    if(!name) return;
    allAccounts.push({ name });
    selectedAccountIdx = allAccounts.length - 1;
    fs.writeFileSync(accountFile, JSON.stringify({ list: allAccounts, lastUsed: selectedAccountIdx }, null, 2));
    renderUI(); closeAccountModal();
};

window.openDir = (f) => {
    const dir = path.join(instancesRoot, allInstances[selectedInstanceIdx].name.replace(/[^a-z0-9]/gi, '_'), f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
};

window.deleteInstance = () => {
    if(confirm("Supprimer l'instance ?")) {
        allInstances.splice(selectedInstanceIdx, 1);
        fs.writeFileSync(instanceFile, JSON.stringify(allInstances, null, 2));
        selectedInstanceIdx = null; renderUI();
    }
};