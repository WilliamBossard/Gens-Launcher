const { Client } = require('minecraft-launcher-core');
const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const launcher = new Client();

const dataDir = path.join(process.env.APPDATA, 'GensLauncher');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const instanceFile = path.join(dataDir, 'instances.json');
const accountFile = path.join(dataDir, 'accounts.json');
const instancesRoot = path.join(dataDir, 'instances');
if (!fs.existsSync(instancesRoot)) fs.mkdirSync(instancesRoot, { recursive: true });

const defaultIcons = {
    vanilla: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%2317B139'/%3E%3Crect x='1' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='5' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='3' y='4' width='2' height='3' fill='%23000'/%3E%3C/svg%3E",
    forge: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%232b2b2b'/%3E%3Cpath d='M3 4h10v3H3zM6 7h4v2H6zM4 9h8v2H4zM2 11h12v3H2z' fill='%238c8c8c'/%3E%3C/svg%3E",
    fabric: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23e2d4b7'/%3E%3Cpath d='M0 4h16v2H0zM0 10h16v2H0zM4 0h2v16H4zM10 0h2v16H10z' fill='%23c8b593'/%3E%3C/svg%3E"
};

let allInstances = [], allAccounts = [], rawVersions = [];
let selectedInstanceIdx = null, selectedAccountIdx = null;

document.addEventListener('DOMContentLoaded', () => init());

async function init() {
    document.getElementById('app-version').innerText = "v" + require('./package.json').version;

    loadStorage();
    try {
        const res = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
        const data = await res.json();
        rawVersions = data.versions;
        updateVersionList(false);
    } catch (e) { console.error("API Mojang injoignable"); }
}

window.updateVersionList = (showSnapshots) => {
    const select = document.getElementById('new-version');
    select.innerHTML = "";
    rawVersions.forEach(v => {
        if (showSnapshots || v.type === "release") {
            let opt = document.createElement('option');
            opt.value = v.id;
            opt.innerHTML = (v.type === "release") ? v.id : `[BÊTA] ${v.id}`;
            select.appendChild(opt);
        }
    });
};

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

document.getElementById('launch-btn').addEventListener('click', async () => {
    const inst = allInstances[selectedInstanceIdx];
    const acc = allAccounts[selectedAccountIdx];
    const safeName = inst.name.replace(/[^a-z0-9]/gi, '_');
    const instancePath = path.join(instancesRoot, safeName);
    const progBar = document.getElementById('progress-bar');
    const logOutput = document.getElementById('log-output');

    document.getElementById('console-container').style.display = 'block';
    logOutput.innerHTML = `<span style="color:#007acc">[SYSTEM] Lancement de ${inst.name} (${inst.version})...</span>\n`;

    let opts = {
        authorization: { access_token: "null", client_token: "null", uuid: "null", name: acc.name, user_properties: "{}" },
        root: instancePath,
        version: { number: inst.version, type: "release" },
        memory: { max: (inst.ram || 4) + "G", min: "1G" },
        javaPath: "javaw",
        spawnOptions: { detached: false, shell: false, windowsHide: true }
    };

    if (inst.loader === "fabric") {
        try {
            document.getElementById('status-text').innerText = "INSTALLATION FABRIC...";
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
                    logOutput.innerHTML += `[SYSTEM] Téléchargement du profil Fabric...\n`;
                    const jsonUrl = `https://meta.fabricmc.net/v2/versions/loader/${inst.version}/${lVer}/profile/json`;
                    const response = await fetch(jsonUrl);
                    const jsonContent = await response.text();
                    fs.writeFileSync(jsonPath, jsonContent);
                }
                logOutput.innerHTML += `[SYSTEM] Fabric ${lVer} est prêt.\n`;
            } else {
                logOutput.innerHTML += `[ERROR] Aucune version Fabric trouvée pour ${inst.version}.\n`;
                return;
            }
        } catch(e) { 
            logOutput.innerHTML += `<span style="color:red">[ERROR] Échec de l'installation Fabric: ${e.message}</span>\n`; 
            return;
        }
    }

    document.getElementById('status-text').innerText = "PRÉPARATION DES FICHIERS...";
    document.getElementById('launch-btn').disabled = true;

    launcher.launch(opts);

    launcher.on('progress', (e) => {
        let perc = 0;
        if (e.total > 0) perc = Math.round((e.task / e.total) * 100);
        progBar.style.width = perc + "%";
        document.getElementById('status-text').innerText = `MAJ: ${e.type} (${perc}%)`;
    });

    launcher.on('data', (data) => {
        logOutput.insertAdjacentHTML('beforeend', `<span>[GAME] ${data}</span><br>`);
        logOutput.scrollTop = logOutput.scrollHeight;
    });

    launcher.on('debug', (data) => {
        logOutput.insertAdjacentHTML('beforeend', `<span style="color:#888">[DEBUG] ${data}</span><br>`);
        logOutput.scrollTop = logOutput.scrollHeight;
    });

    launcher.on('close', (code) => {
        logOutput.insertAdjacentHTML('beforeend', `<br><span style="color:red">[SYSTEM] Le jeu s'est arrêté (Code ${code})</span><br>`);
        document.getElementById('status-text').innerText = "PRÊT.";
        document.getElementById('launch-btn').disabled = false;
        progBar.style.width = "0%";
    });
});

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