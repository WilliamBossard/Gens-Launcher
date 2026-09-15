<template>
  <div class="genscore-banner">
    <div class="banner-inner">
      <div class="banner-badge">{{ isFr ? 'Écosystème Gens' : 'Gens Ecosystem' }}</div>
      <h3 class="banner-title">
        {{ isFr ? 'Vous administrez un serveur ? Découvrez GensCore' : 'Running a Minecraft Server? Discover GensCore' }}
      </h3>
      <p class="banner-desc">
        {{ isFr 
          ? 'Le plugin Core autonome haute performance pour PaperMC & Folia (Minecraft 26.2+ sur Java 25). Économie dynamique, base SQLite WAL embarquée, threading régional sans lag et panel web d\'administration.' 
          : 'The ultimate standalone high-performance core plugin for PaperMC & Folia (Minecraft 26.2+ on Java 25). Regional Folia threading, built-in SQLite WAL engine, dynamic economy, and web panel.' 
        }}
      </p>
      <div class="banner-chips">
        <span class="chip">PaperMC & Folia</span>
        <span class="chip">Java 25 (LTS)</span>
        <span class="chip">SQLite WAL</span>
        <span class="chip">Web Panel React</span>
      </div>
      <div class="banner-actions">
        <a href="https://williambossard.github.io/GensCore/" target="_blank" class="banner-btn primary">
          {{ isFr ? 'Consulter la Documentation GensCore' : 'Explore GensCore Documentation' }}
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
        </a>
        <a href="https://github.com/WilliamBossard/GensCore" target="_blank" class="banner-btn secondary">
          GitHub Repository
        </a>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  lang?: string
}>()

const isFr = computed(() => props.lang === 'fr')
</script>

<style scoped>
.genscore-banner {
  max-width: 900px;
  margin: 3rem auto 2rem;
  padding: 0 1rem;
}

.banner-inner {
  background: linear-gradient(135deg, rgba(30, 41, 59, 0.7) 0%, rgba(15, 23, 42, 0.8) 100%);
  border: 1px solid rgba(56, 189, 248, 0.3);
  border-radius: 12px;
  padding: 2rem;
  position: relative;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.banner-badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.15);
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  border: 1px solid rgba(56, 189, 248, 0.3);
  margin-bottom: 0.8rem;
}

.banner-title {
  font-size: 1.35rem;
  font-weight: 700;
  color: #fff;
  margin-bottom: 0.6rem;
}

.banner-desc {
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
  line-height: 1.6;
  margin-bottom: 1.2rem;
}

.banner-chips {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 1.5rem;
}

.chip {
  font-size: 0.75rem;
  font-weight: 600;
  color: #cbd5e1;
  background: rgba(255, 255, 255, 0.08);
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  font-family: var(--vp-font-family-mono);
}

.banner-actions {
  display: flex;
  gap: 0.8rem;
  flex-wrap: wrap;
}

.banner-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1.2rem;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
  text-decoration: none;
  transition: all 0.2s ease;
}

.banner-btn.primary {
  background: #0284c7;
  color: #fff !important;
}

.banner-btn.primary:hover {
  background: #0369a1;
  transform: translateY(-1px);
}

.banner-btn.secondary {
  background: rgba(255, 255, 255, 0.08);
  color: #e2e8f0 !important;
  border: 1px solid rgba(255, 255, 255, 0.15);
}

.banner-btn.secondary:hover {
  background: rgba(255, 255, 255, 0.15);
}
</style>
