<template>
  <div class="install-section" id="install">
    <div class="install-header">
      <h2 class="install-title">{{ isFr ? 'Installation Multi-Plateforme' : 'Multi-Platform Installation' }}</h2>
      <p class="install-subtitle">
        {{ isFr ? 'Choisissez votre système d\'exploitation pour télécharger Gens Launcher :' : 'Choose your operating system to download and install Gens Launcher:' }}
      </p>
    </div>

    <div class="tabs-bar">
      <button 
        v-for="tab in tabs" 
        :key="tab.id"
        :class="['tab-btn', { active: activeTab === tab.id }]"
        @click="activeTab = tab.id"
      >
        <span class="tab-label">{{ tab.label }}</span>
      </button>
    </div>

    <div class="tab-card">
      <!-- Windows -->
      <div v-if="activeTab === 'windows'" class="tab-pane">
        <div class="pane-content">
          <h3>Windows (10 / 11 64-bit)</h3>
          <p>{{ isFr ? 'Téléchargez l\'installateur officiel complet pour Windows avec raccourcis bureau et menu démarrer.' : 'Download the official Windows installer bundle with desktop and start menu shortcuts.' }}</p>
          <div class="action-row">
            <a href="https://github.com/WilliamBossard/Gens-Launcher/releases/latest" target="_blank" class="download-btn primary">
              <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              {{ isFr ? 'Télécharger .exe' : 'Download .exe Installer' }}
            </a>
          </div>
          <div class="info-box">
            <strong>{{ isFr ? 'Avis Windows SmartScreen :' : 'Windows SmartScreen Notice:' }}</strong>
            {{ isFr ? 'Projet indépendant libre. Si Windows affiche un message bleu, cliquez sur "Informations complémentaires" puis "Exécuter quand même".' : 'Independent open-source project. If Windows shows a blue warning, click "More info" and then "Run anyway".' }}
          </div>
        </div>
      </div>

      <!-- macOS -->
      <div v-if="activeTab === 'macos'" class="tab-pane">
        <div class="pane-content">
          <h3>macOS (Intel & Apple Silicon)</h3>
          <p>{{ isFr ? 'Image disque Apple universelle compatible avec les puces Intel et Apple Silicon (M1, M2, M3, M4).' : 'Universal Apple Disk Image supporting Intel and Apple Silicon (M1, M2, M3, M4) architectures.' }}</p>
          <div class="action-row">
            <a href="https://github.com/WilliamBossard/Gens-Launcher/releases/latest" target="_blank" class="download-btn primary">
              <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              {{ isFr ? 'Télécharger .dmg' : 'Download .dmg Disk Image' }}
            </a>
          </div>
          <div class="info-box">
            <strong>{{ isFr ? 'Important :' : 'Important:' }}</strong>
            {{ isFr ? 'Glissez l\'icône Gens Launcher dans le dossier /Applications pour activer les mises à jour automatiques.' : 'Drag the Gens Launcher icon into your /Applications directory to enable background updates.' }}
          </div>
        </div>
      </div>

      <!-- Linux AppImage -->
      <div v-if="activeTab === 'appimage'" class="tab-pane">
        <div class="pane-content">
          <h3>Linux AppImage (Universal)</h3>
          <p>{{ isFr ? 'Format autonome sans dépendances externes. Fonctionne sur Fedora, Arch Linux, Debian, Ubuntu et autres.' : 'Standalone portable format with zero external dependencies. Works on Fedora, Arch, Ubuntu, and Debian.' }}</p>
          <div class="action-row">
            <a href="https://github.com/WilliamBossard/Gens-Launcher/releases/latest" target="_blank" class="download-btn primary">
              <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              {{ isFr ? 'Télécharger .AppImage' : 'Download .AppImage' }}
            </a>
          </div>
          <div class="code-box">
            <pre><code>chmod +x GensLauncher-*.AppImage
./GensLauncher-*.AppImage</code></pre>
          </div>
        </div>
      </div>

      <!-- Linux APT -->
      <div v-if="activeTab === 'apt'" class="tab-pane">
        <div class="pane-content">
          <h3>Debian & Ubuntu (Dépôt APT Officiel)</h3>
          <p>{{ isFr ? 'Mises à jour transparentes intégrées à votre gestionnaire de paquets officiel :' : 'Automatic updates integrated seamlessly with your system package manager:' }}</p>
          
          <div class="code-block-wrapper">
            <div class="code-header">
              <span>bash</span>
              <button class="copy-btn" @click="copyAptCommand">
                {{ copied ? (isFr ? 'Copié !' : 'Copied!') : (isFr ? 'Copier' : 'Copy') }}
              </button>
            </div>
            <pre><code>curl -fsSL https://williambossard.github.io/Gens-Launcher/public.key | sudo gpg --dearmor -o /usr/share/keyrings/gens-launcher-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/gens-launcher-keyring.gpg] https://williambossard.github.io/Gens-Launcher/ ./" | sudo tee /etc/apt/sources.list.d/gens-launcher.list
sudo apt update && sudo apt install gens-launcher</code></pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  lang?: string
}>()

const isFr = computed(() => props.lang === 'fr')

const tabs = computed(() => [
  { id: 'windows', label: 'Windows (.exe)' },
  { id: 'macos', label: 'macOS (.dmg)' },
  { id: 'appimage', label: 'Linux (AppImage)' },
  { id: 'apt', label: 'Debian / Ubuntu (APT)' }
])

const activeTab = ref('windows')
const copied = ref(false)

const aptCommand = `curl -fsSL https://williambossard.github.io/Gens-Launcher/public.key | sudo gpg --dearmor -o /usr/share/keyrings/gens-launcher-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/gens-launcher-keyring.gpg] https://williambossard.github.io/Gens-Launcher/ ./" | sudo tee /etc/apt/sources.list.d/gens-launcher.list
sudo apt update && sudo apt install gens-launcher`

function copyAptCommand() {
  navigator.clipboard.writeText(aptCommand)
  copied.value = true
  setTimeout(() => {
    copied.value = false
  }, 2000)
}
</script>

<style scoped>
.install-section {
  max-width: 900px;
  margin: 3rem auto 2rem;
  padding: 0 1rem;
}

.install-header {
  text-align: center;
  margin-bottom: 1.5rem;
}

.install-title {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 0.5rem;
  color: var(--vp-c-text-1);
}

.install-subtitle {
  color: var(--vp-c-text-2);
  font-size: 1rem;
}

.tabs-bar {
  display: flex;
  gap: 0.5rem;
  justify-content: center;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}

.tab-btn {
  padding: 0.6rem 1.2rem;
  font-size: 0.9rem;
  font-weight: 600;
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  border: 1px solid var(--vp-c-divider);
  cursor: pointer;
  transition: all 0.2s ease;
}

.tab-btn:hover {
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-brand-1);
}

.tab-btn.active {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

.tab-card {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 1.8rem;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
}

.tab-pane h3 {
  font-size: 1.2rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--vp-c-text-1);
}

.tab-pane p {
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
  line-height: 1.5;
  margin-bottom: 1.2rem;
}

.action-row {
  margin-bottom: 1.2rem;
}

.download-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.65rem 1.4rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.95rem;
  transition: all 0.2s ease;
  background: var(--vp-c-brand-1);
  color: #fff !important;
  text-decoration: none;
}

.download-btn:hover {
  background: var(--vp-c-brand-2);
  transform: translateY(-1px);
}

.info-box {
  background: rgba(0, 122, 204, 0.08);
  border-left: 3px solid var(--vp-c-brand-1);
  padding: 0.8rem 1rem;
  border-radius: 0 6px 6px 0;
  font-size: 0.85rem;
  color: var(--vp-c-text-1);
  line-height: 1.4;
}

.code-block-wrapper, .code-box {
  background: #161618;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: hidden;
}

.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.4rem 0.8rem;
  background: #1e1e20;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
  text-transform: uppercase;
  font-weight: 600;
}

.copy-btn {
  background: transparent;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  padding: 0.2rem 0.6rem;
  font-size: 0.75rem;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.2s;
}

.copy-btn:hover {
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-brand-1);
}

pre {
  margin: 0;
  padding: 1rem;
  overflow-x: auto;
}

code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  line-height: 1.5;
  color: #e6edf3;
}
</style>
