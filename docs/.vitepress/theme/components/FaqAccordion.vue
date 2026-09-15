<template>
  <div class="faq-section">
    <div class="faq-header">
      <h2 class="faq-title">{{ isFr ? 'Questions Fréquentes' : 'Frequently Asked Questions' }}</h2>
      <p class="faq-subtitle">{{ isFr ? 'Tout ce que vous devez savoir sur Gens Launcher et ses fonctionnalités.' : 'Everything you need to know about Gens Launcher and its features.' }}</p>
    </div>

    <div class="faq-list">
      <div 
        v-for="(item, idx) in questions" 
        :key="idx"
        class="faq-item"
        :class="{ open: openIndex === idx }"
      >
        <button class="faq-question" @click="toggle(idx)">
          <span>{{ item.q }}</span>
          <span class="faq-icon">{{ openIndex === idx ? '−' : '+' }}</span>
        </button>
        <div v-show="openIndex === idx" class="faq-answer">
          <p>{{ item.a }}</p>
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
const openIndex = ref<number | null>(null)

function toggle(idx: number) {
  openIndex.value = openIndex.value === idx ? null : idx
}

const questionsFr = [
  {
    q: 'Gens Launcher prend-il en charge les comptes hors-ligne ?',
    a: 'Oui. Bien que nous recommandions l\'authentification officielle Microsoft pour jouer sur les serveurs vérifiés et synchroniser vos skins, Gens Launcher intègre un mode hors-ligne complet permettant de lancer toutes vos instances locales sans connexion.'
  },
  {
    q: 'Pourquoi Windows affiche-t-il une alerte SmartScreen au premier lancement ?',
    a: 'Gens Launcher est un projet indépendant libre sans certificat commercial EV d\'entreprise (qui coûte plusieurs centaines d\'euros par an). Le logiciel est 100% sûr et son code source est intégralement public sur GitHub. Cliquez simplement sur "Informations complémentaires" puis sur "Exécuter quand même".'
  },
  {
    q: 'Comment fonctionne la synchronisation Cloud Horizon ?',
    a: 'Le moteur déporté Gens-Horizon analyse vos fichiers modifiés et n\'envoie que la différence (Delta Sync) vers votre propre Google Drive, Dropbox ou OneDrive. Cela réduit les transferts à quelques mégaoctets et sauvegarde vos mondes en quelques secondes.'
  },
  {
    q: 'Mes identifiants de compte sont-ils sécurisés ?',
    a: 'Oui, totalement. Le lanceur utilise le flux officiel OAuth2 Device Code de Microsoft. Le lanceur ne voit jamais votre mot de passe. Vos jetons de session sont chiffrés sur votre machine via AES-256-GCM et protégés par PBKDF2 à 600 000 itérations.'
  },
  {
    q: 'Gens Launcher est-il totalement gratuit ?',
    a: 'Oui, Gens Launcher est 100% gratuit, sans publicité, sans abonnement, et distribué sous la licence libre MIT. Il ne comporte aucun pistage ni revente de données.'
  }
]

const questionsEn = [
  {
    q: 'Does Gens Launcher support cracked or offline accounts?',
    a: 'Yes. While we strongly encourage official Microsoft accounts for access to verified servers and skin synchronization, Gens Launcher includes built-in support for offline accounts on local networks.'
  },
  {
    q: 'Why does Windows show a SmartScreen warning upon installation?',
    a: 'Gens Launcher is an open-source, non-profit indie project without an expensive corporate EV certificate. The installer is completely safe and auditable on GitHub. Simply click "More info" and then "Run anyway".'
  },
  {
    q: 'How does Horizon Cloud Sync work?',
    a: 'It relies on differential Delta Sync technology. Instead of redownloading your entire modpack or save data, it calculates binary differences and only uploads or downloads the exact bytes that changed, completing in seconds.'
  },
  {
    q: 'Are my Microsoft account credentials secure?',
    a: 'Yes, completely. Gens Launcher relies on Microsoft\'s official OAuth2 Device Code Flow. The app never sees or handles your password. Session tokens are encrypted locally with AES-256-GCM and derived via PBKDF2 across 600,000 iterations.'
  },
  {
    q: 'Is Gens Launcher completely free?',
    a: 'Yes, Gens Launcher is 100% free, open-source under the MIT license, and contains zero commercial tracking, telemetry, or hidden ads.'
  }
]

const questions = computed(() => isFr.value ? questionsFr : questionsEn)
</script>

<style scoped>
.faq-section {
  max-width: 900px;
  margin: 3rem auto 4rem;
  padding: 0 1rem;
}

.faq-header {
  text-align: center;
  margin-bottom: 1.5rem;
}

.faq-title {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin-bottom: 0.5rem;
}

.faq-subtitle {
  color: var(--vp-c-text-2);
  font-size: 1rem;
}

.faq-list {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

.faq-item {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: hidden;
  transition: border-color 0.2s;
}

.faq-item.open {
  border-color: var(--vp-c-brand-1);
}

.faq-question {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.2rem;
  background: transparent;
  border: none;
  color: var(--vp-c-text-1);
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}

.faq-icon {
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  margin-left: 1rem;
}

.faq-answer {
  padding: 0 1.2rem 1.2rem;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.faq-answer p {
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
  line-height: 1.6;
  margin-top: 0.8rem;
}
</style>
