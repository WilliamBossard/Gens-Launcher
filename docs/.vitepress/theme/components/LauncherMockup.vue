<template>
  <div class="mockup-section">
    <div class="mockup-window">
      <div class="window-bar">
        <div class="traffic-lights">
          <span class="light red"></span>
          <span class="light yellow"></span>
          <span class="light green"></span>
        </div>
        <div class="window-title">Gens Launcher — Survival 1.21 Fabric (Horizon Delta Sync)</div>
        <div class="window-spacer"></div>
      </div>

      <div class="mockup-content">
        <div class="launcher-header">
          <div class="instance-avatar">
            <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
          </div>
          <div class="instance-meta">
            <div class="instance-name">Survival 1.21 Fabric</div>
            <div class="instance-details">Minecraft 1.21.4 • Fabric 0.16.9 • 38 Mods • Horizon Smart Sync</div>
          </div>
          <div class="status-badge" :class="{ running: isRunning }">
            {{ isRunning ? (isFr ? 'En Jeu' : 'In Game') : (isFr ? 'Préparation' : 'Preparing') }}
          </div>
        </div>

        <div class="progress-container">
          <div class="step-info">
            <span class="step-title">{{ currentStep.title }}</span>
            <span class="step-percentage">{{ Math.round(progress) }}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-bar" :style="{ width: progress + '%' }"></div>
          </div>
          <div class="step-desc">{{ currentStep.desc }}</div>
        </div>

        <div class="mockup-footer">
          <div class="footer-stat">
            <span class="stat-label">{{ isFr ? 'Mémoire' : 'Memory' }}</span>
            <span class="stat-value">4096 MB / 16 GB</span>
          </div>
          <div class="footer-stat">
            <span class="stat-label">Java</span>
            <span class="stat-value">Java 21 (Adoptium LTS)</span>
          </div>
          <div class="footer-stat">
            <span class="stat-label">Cloud</span>
            <span class="stat-value">Google Drive (Delta Active)</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  lang?: string
}>()

const isFr = computed(() => props.lang === 'fr')

const stepsFr = [
  { title: 'Authentification Microsoft', desc: 'Validation de session OAuth2 Device Code...' },
  { title: 'Vérification d\'intégrité', desc: 'Contrôle des hachages SHA-1 des bibliothèques...' },
  { title: 'Gestionnaire de Mods', desc: 'Vérification des mises à jour Modrinth & CurseForge...' },
  { title: 'Horizon Cloud Sync', desc: 'Application du correctif Delta Patch (1.8 Mo transférés)...' },
  { title: 'Démarrage de la JVM', desc: 'Initialisation de la machine virtuelle Java 21...' },
  { title: 'Partie en cours', desc: 'Minecraft 1.21.4 s\'exécute avec succès.' }
]

const stepsEn = [
  { title: 'Microsoft Authentication', desc: 'Validating OAuth2 Device Code session...' },
  { title: 'Integrity Verification', desc: 'Checking SHA-1 library hashes against Mojang manifests...' },
  { title: 'Mod Manager', desc: 'Checking Modrinth and CurseForge dependency updates...' },
  { title: 'Horizon Cloud Sync', desc: 'Applying Delta Patch (1.8 MB downloaded)...' },
  { title: 'Starting JVM', desc: 'Spawning Java 21 Virtual Machine via child_process...' },
  { title: 'Game Running', desc: 'Minecraft 1.21.4 launched successfully.' }
]

const steps = computed(() => isFr.value ? stepsFr : stepsEn)
const currentStepIndex = ref(0)
const progress = ref(0)
const isRunning = ref(false)

const currentStep = computed(() => steps.value[currentStepIndex.value])

let animationTimer: any = null

function runSimulation() {
  progress.value = 0
  currentStepIndex.value = 0
  isRunning.value = false

  const targets = [15, 38, 65, 88, 100]
  let currentTargetIndex = 0

  const interval = setInterval(() => {
    if (currentTargetIndex < targets.length) {
      currentStepIndex.value = currentTargetIndex
      const target = targets[currentTargetIndex]
      if (progress.value < target) {
        progress.value += 1.5
      } else {
        currentTargetIndex++
      }
    } else {
      progress.value = 100
      currentStepIndex.value = steps.value.length - 1
      isRunning.value = true
      clearInterval(interval)
      animationTimer = setTimeout(runSimulation, 5000)
    }
  }, 40)
}

onMounted(() => {
  runSimulation()
})

onUnmounted(() => {
  if (animationTimer) clearTimeout(animationTimer)
})
</script>

<style scoped>
.mockup-section {
  max-width: 900px;
  margin: 2rem auto;
  padding: 0 1rem;
}

.mockup-window {
  background: #18181b;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.35);
}

.window-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 1rem;
  background: #121214;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.traffic-lights {
  display: flex;
  gap: 6px;
}

.light {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.light.red { background: #ff5f56; }
.light.yellow { background: #ffbd2e; }
.light.green { background: #27c93f; }

.window-title {
  font-size: 0.8rem;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
}

.window-spacer {
  width: 40px;
}

.mockup-content {
  padding: 1.5rem;
}

.launcher-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.instance-avatar {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--vp-c-brand-1);
}

.instance-meta {
  flex: 1;
}

.instance-name {
  font-size: 1.05rem;
  font-weight: 700;
  color: #fff;
}

.instance-details {
  font-size: 0.8rem;
  color: var(--vp-c-text-3);
}

.status-badge {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.3rem 0.8rem;
  border-radius: 999px;
  background: rgba(255, 189, 46, 0.15);
  color: #ffbd2e;
  border: 1px solid rgba(255, 189, 46, 0.3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.status-badge.running {
  background: rgba(39, 201, 63, 0.15);
  color: #27c93f;
  border-color: rgba(39, 201, 63, 0.3);
}

.progress-container {
  background: #121214;
  padding: 1.2rem;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  margin-bottom: 1.2rem;
}

.step-info {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.6rem;
  font-size: 0.9rem;
}

.step-title {
  font-weight: 600;
  color: #fff;
}

.step-percentage {
  font-weight: 700;
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
}

.progress-track {
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 0.6rem;
}

.progress-bar {
  height: 100%;
  background: var(--vp-c-brand-1);
  border-radius: 3px;
  transition: width 0.1s linear;
}

.step-desc {
  font-size: 0.8rem;
  color: var(--vp-c-text-3);
}

.mockup-footer {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
  padding-top: 1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.footer-stat {
  display: flex;
  flex-direction: column;
}

.stat-label {
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
  text-transform: uppercase;
  font-weight: 600;
}

.stat-value {
  font-size: 0.85rem;
  color: #fff;
  font-family: var(--vp-font-family-mono);
}
</style>
