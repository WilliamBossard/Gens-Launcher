<template>
  <div class="gallery-section">
    <div class="gallery-header">
      <h2 class="gallery-title">{{ isFr ? 'Aperçu de l\'Interface' : 'Interface Preview' }}</h2>
      <p class="gallery-subtitle">{{ isFr ? 'Une interface pensée pour la simplicité, la rapidité et la personnalisation.' : 'An interface designed for clarity, speed, and deep customization.' }}</p>
    </div>

    <div class="gallery-grid">
      <div 
        v-for="(item, idx) in items" 
        :key="idx" 
        class="gallery-card"
        @click="openLightbox(item.src)"
      >
        <div class="img-wrapper">
          <img :src="item.src" :alt="item.caption" loading="lazy" />
          <div class="zoom-overlay">
            <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2" fill="none"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>
          </div>
        </div>
        <div class="gallery-caption">{{ item.caption }}</div>
      </div>
    </div>

    <!-- Lightbox Modal -->
    <div v-if="activeImage" class="lightbox-backdrop" @click="closeLightbox">
      <div class="lightbox-content" @click.stop>
        <button class="close-btn" @click="closeLightbox">
          <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
        <img :src="activeImage" alt="Fullscreen preview" />
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

const items = computed(() => [
  {
    src: 'https://github.com/user-attachments/assets/a9d5026b-2db1-411d-9d77-03930b884fa0',
    caption: isFr.value ? 'Écran d\'Accueil Épuré' : 'Clean & Modern Home Interface'
  },
  {
    src: 'https://github.com/user-attachments/assets/d0557c34-0b6c-4dff-835c-c55a3cfc754c',
    caption: isFr.value ? 'Gestion Avancée des Instances' : 'Advanced Instance Management'
  },
  {
    src: 'https://github.com/user-attachments/assets/9694ea7b-1b97-410a-9cad-f3d69cb742a3',
    caption: isFr.value ? 'Catalogue de Contenu Intégré' : 'Integrated Content Catalog'
  }
])

const activeImage = ref<string | null>(null)

function openLightbox(src: string) {
  activeImage.value = src
}

function closeLightbox() {
  activeImage.value = null
}
</script>

<style scoped>
.gallery-section {
  max-width: 900px;
  margin: 3rem auto 2rem;
  padding: 0 1rem;
}

.gallery-header {
  text-align: center;
  margin-bottom: 1.5rem;
}

.gallery-title {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin-bottom: 0.5rem;
}

.gallery-subtitle {
  color: var(--vp-c-text-2);
  font-size: 1rem;
}

.gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1.5rem;
}

.gallery-card {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s ease;
}

.gallery-card:hover {
  transform: translateY(-3px);
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}

.img-wrapper {
  position: relative;
  overflow: hidden;
  aspect-ratio: 16 / 10;
  background: #111;
}

.img-wrapper img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.3s ease;
}

.gallery-card:hover .img-wrapper img {
  transform: scale(1.03);
}

.zoom-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.gallery-card:hover .zoom-overlay {
  opacity: 1;
}

.gallery-caption {
  padding: 0.8rem 1rem;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
  text-align: center;
}

.lightbox-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(8px);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}

.lightbox-content {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
}

.lightbox-content img {
  max-width: 100%;
  max-height: 85vh;
  border-radius: 8px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.close-btn {
  position: absolute;
  top: -40px;
  right: 0;
  background: transparent;
  border: none;
  color: #fff;
  cursor: pointer;
  padding: 0.5rem;
}
</style>
