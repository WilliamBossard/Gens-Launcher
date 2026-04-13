import { store } from "./store.js";

const fs = window.api.fs;

function t(key, fallback) {
    return store.currentLangObj[key] || fallback;
}

export const ACHIEVEMENTS = [
    { 
        id: "first_launch", 
        icon: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%2317B139'/%3E%3Crect x='1' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='5' y='2' width='2' height='2' fill='%23000'/%3E%3Crect x='3' y='4' width='2' height='3' fill='%23000'/%3E%3C/svg%3E", 
        nameKey: "adv_first_launch_name", 
        descKey: "adv_first_launch_desc" 
    },
    { 
        id: "modder", 
        icon: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23f48a21'/%3E%3Cpath d='M3 4h10v3H3zM6 7h4v2H6zM4 9h8v2H4zM2 11h12v3H2z' fill='%23ffffff'/%3E%3C/svg%3E", 
        nameKey: "adv_modder_name", 
        descKey: "adv_modder_desc" 
    },
    { 
        id: "cleaner", 
        icon: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M2 14h12v2H2zM4 8h3v6H4zM9 8h3v6H9z' fill='%238b5a2b'/%3E%3C/svg%3E", 
        nameKey: "adv_cleaner_name", 
        descKey: "adv_cleaner_desc" 
    },
    { 
        id: "architect", 
        icon: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='2' y='2' width='12' height='12' fill='%23555'/%3E%3Cpath d='M2 2l12 12M14 2L2 14' stroke='%23fff'/%3E%3C/svg%3E", 
        nameKey: "adv_architect_name", 
        descKey: "adv_architect_desc" 
    },
    { 
        id: "collector", 
        icon: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%2300aaaa'/%3E%3Cpath d='M8 4v8M4 8h8' stroke='%23fff'/%3E%3C/svg%3E", 
        nameKey: "adv_collector_name", 
        descKey: "adv_collector_desc" 
    },
    { 
        id: "veteran", 
        icon: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%23ffd700'/%3E%3Ccircle cx='8' cy='8' r='5' fill='%23fff'/%3E%3Cpath d='M8 4v4l3 3' stroke='%23000' stroke-width='1.5' fill='none'/%3E%3C/svg%3E", 
        nameKey: "adv_veteran_name", 
        descKey: "adv_veteran_desc" 
    },
    { 
        id: "killer", 
        icon: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M14 2l-8 8-2-2 8-8zM4 10l-2 2-1-1-1 4 4-1-1-1 2-2z' fill='%23aaa'/%3E%3Cpath d='M13 3l-6 6-1-1 6-6z' fill='%23fff'/%3E%3C/svg%3E", 
        nameKey: "adv_killer_name", 
        descKey: "adv_killer_desc" 
    },
    { 
        id: "explorer", 
        icon: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 2l6 6-6 6-6-6z' fill='%2355ffff'/%3E%3C/svg%3E", 
        nameKey: "adv_explorer_name", 
        descKey: "adv_explorer_desc" 
    },
    { 
        id: "night_owl", 
        icon: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 2A6 6 0 1014 8 4 4 0 018 2z' fill='%23aaffff'/%3E%3C/svg%3E", 
        nameKey: "adv_nightowl_name", 
        descKey: "adv_nightowl_desc" 
    },
    { 
        id: "artist", 
        icon: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%23ff55ff'/%3E%3Ccircle cx='5' cy='6' r='1.5' fill='%23fff'/%3E%3Ccircle cx='11' cy='6' r='1.5' fill='%23fff'/%3E%3Ccircle cx='8' cy='11' r='1.5' fill='%23fff'/%3E%3C/svg%3E", 
        nameKey: "adv_artist_name", 
        descKey: "adv_artist_desc" 
    },
    { 
        id: "vip", 
        icon: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M2 6l3 6h6l3-6-4 2-2-4-2 4z' fill='%23ffaa00'/%3E%3C/svg%3E", 
        nameKey: "adv_vip_name", 
        descKey: "adv_vip_desc" 
    },
    { 
        id: "kangaroo", 
        icon: "data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 2l-4 6h8zM8 8l-4 6h8z' fill='%2355ff55'/%3E%3C/svg%3E", 
        nameKey: "adv_kangaroo_name", 
        descKey: "adv_kangaroo_desc" 
    },
];

/**
 * 
 * @param {string} id 
 */
export function checkAchievement(id) {
    if (!store.globalSettings.unlockedAchievements) {
        store.globalSettings.unlockedAchievements = [];
    }
    
    if (store.globalSettings.unlockedAchievements.includes(id)) {
        return;
    }

    store.globalSettings.unlockedAchievements.push(id);
    
    if (window.safeWriteJSON) {
        window.safeWriteJSON(store.settingsFile, store.globalSettings);
    }

    const adv = ACHIEVEMENTS.find(a => a.id === id);
    if (!adv) return;

    const container = document.getElementById("advancement-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = "advancement-toast";
    
    toast.innerHTML = `
        <img src="${adv.icon}" class="advancement-icon">
        <div class="advancement-text">
            <span class="advancement-title">${t("adv_unlocked", "Progrès réalisé !")}</span>
            <span class="advancement-name">${t(adv.nameKey, "Succès")}</span>
        </div>
    `;
    
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.transition = "opacity 0.8s ease, transform 0.8s ease";
        toast.style.opacity = "0";
        toast.style.transform = "translateX(150%)"; 
        setTimeout(() => toast.remove(), 800);
    }, 5000);
}