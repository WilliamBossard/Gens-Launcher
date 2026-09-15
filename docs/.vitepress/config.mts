import { defineConfig } from 'vitepress'

export default defineConfig({
  base: '/Gens-Launcher/docs/',
  outDir: '../website/docs',
  cleanUrls: true,

  head: [
    ['link', { rel: 'icon', href: '/Gens-Launcher/docs/icon.png' }],
    [
      'script',
      {},
      `
      (function() {
        var base = window.location.pathname.indexOf('/Gens-Launcher/docs/') === 0 ? '/Gens-Launcher/docs/' : '/docs/';
        var path = window.location.pathname;
        var isFr = path.indexOf(base + 'fr/') === 0 || path === base + 'fr' || path === base + 'fr.html';
        var savedLang = null;
        try {
          savedLang = localStorage.getItem('genslauncher_lang');
        } catch (e) {}

        if (!savedLang) {
          var navLang = (navigator.languages && navigator.languages[0]) || navigator.language || '';
          if (navLang.toLowerCase().indexOf('fr') === 0) {
            try { localStorage.setItem('genslauncher_lang', 'fr'); } catch(e) {}
            if (!isFr) {
              var target = (path === base || path === base + 'index.html') ? base + 'fr/' : path.replace(base, base + 'fr/');
              window.location.replace(target);
            }
          } else {
            try { localStorage.setItem('genslauncher_lang', 'en'); } catch(e) {}
          }
        } else if (savedLang === 'fr' && !isFr && (path === base || path === base + 'index.html')) {
          window.location.replace(base + 'fr/');
        }
      })();
      `
    ]
  ],

  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      title: 'Gens Launcher',
      description: 'The Ultimate Minecraft Launcher & Horizon Delta Sync Documentation',
      themeConfig: {
        nav: [
          { text: 'Players', link: '/guide/players/getting-started' },
          { text: 'Developers', link: '/guide/dev/architecture' },
          { text: 'Horizon Cloud', link: '/guide/horizon/overview' },
          { text: 'Showcase', link: 'https://williambossard.github.io/Gens-Launcher/' }
        ],
        sidebar: [
          {
            text: 'Player Guide',
            collapsed: false,
            items: [
              { text: 'Getting Started', link: '/guide/players/getting-started' },
              { text: 'Installation (All OS)', link: '/guide/players/installation' },
              { text: 'Instances & Mod Catalog', link: '/guide/players/instances-and-mods' },
              { text: 'Cloud Sync (Horizon)', link: '/guide/players/cloud-sync' },
              { text: 'FAQ & Troubleshooting', link: '/guide/players/troubleshooting' }
            ]
          },
          {
            text: 'Developer Guide',
            collapsed: false,
            items: [
              { text: 'System Architecture', link: '/guide/dev/architecture' },
              { text: 'Security Model & Sandbox', link: '/guide/dev/security-model' },
              { text: 'Native Gens-Core Modules', link: '/guide/dev/native-modules' },
              { text: 'IPC Channel Reference', link: '/guide/dev/ipc-reference' },
              { text: 'Build & Packaging', link: '/guide/dev/build-and-packaging' }
            ]
          },
          {
            text: 'Gens-Horizon Cloud Engine',
            collapsed: false,
            items: [
              { text: 'Engine Overview', link: '/guide/horizon/overview' },
              { text: 'Delta Sync Algorithm', link: '/guide/horizon/delta-sync-algorithm' },
              { text: 'Cloud Providers & Storage', link: '/guide/horizon/providers-and-auth' },
              { text: 'Atomic Locks & Security', link: '/guide/horizon/locks-and-security' }
            ]
          }
        ],
        docFooter: {
          prev: 'Previous page',
          next: 'Next page'
        }
      }
    },
    fr: {
      label: 'Français',
      lang: 'fr-FR',
      link: '/fr/',
      title: 'Gens Launcher',
      description: 'Documentation officielle de Gens Launcher et de la technologie Horizon Delta Sync',
      themeConfig: {
        nav: [
          { text: 'Joueurs', link: '/fr/guide/players/getting-started' },
          { text: 'Développeurs', link: '/fr/guide/dev/architecture' },
          { text: 'Moteur Horizon', link: '/fr/guide/horizon/overview' },
          { text: 'Site Vitrine', link: 'https://williambossard.github.io/Gens-Launcher/' }
        ],
        sidebar: [
          {
            text: 'Guide Joueurs',
            collapsed: false,
            items: [
              { text: 'Démarrage Rapide', link: '/fr/guide/players/getting-started' },
              { text: 'Installation Multi-OS', link: '/fr/guide/players/installation' },
              { text: 'Instances & Catalogue Mods', link: '/fr/guide/players/instances-and-mods' },
              { text: 'Synchronisation Cloud', link: '/fr/guide/players/cloud-sync' },
              { text: 'FAQ & Dépannage', link: '/fr/guide/players/troubleshooting' }
            ]
          },
          {
            text: 'Guide Développeurs',
            collapsed: false,
            items: [
              { text: 'Architecture Système', link: '/fr/guide/dev/architecture' },
              { text: 'Modèle de Sécurité & Sandbox', link: '/fr/guide/dev/security-model' },
              { text: 'Modules Natifs Gens-Core', link: '/fr/guide/dev/native-modules' },
              { text: 'Spécification Canaux IPC', link: '/fr/guide/dev/ipc-reference' },
              { text: 'Compilation & Packaging', link: '/fr/guide/dev/build-and-packaging' }
            ]
          },
          {
            text: 'Moteur Gens-Horizon',
            collapsed: false,
            items: [
              { text: 'Vue d\'ensemble du Moteur', link: '/fr/guide/horizon/overview' },
              { text: 'Algorithme Delta Sync', link: '/fr/guide/horizon/delta-sync-algorithm' },
              { text: 'Fournisseurs Cloud & Auth', link: '/fr/guide/horizon/providers-and-auth' },
              { text: 'Verrous Atomiques & Sécurité', link: '/fr/guide/horizon/locks-and-security' }
            ]
          }
        ],
        docFooter: {
          prev: 'Page précédente',
          next: 'Page suivante'
        }
      }
    }
  },

  themeConfig: {
    logo: '/icon.png',
    siteTitle: 'Gens Launcher Docs',

    search: {
      provider: 'local',
      options: {
        locales: {
          fr: {
            translations: {
              button: {
                buttonText: 'Rechercher',
                buttonAriaLabel: 'Rechercher dans la documentation'
              },
              modal: {
                displayDetails: 'Afficher les détails',
                resetButtonTitle: 'Effacer la recherche',
                backButtonTitle: 'Retour',
                noResultsText: 'Aucun résultat pour',
                footer: {
                  selectText: 'choisir',
                  navigateText: 'naviguer',
                  closeText: 'fermer'
                }
              }
            }
          }
        }
      }
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/WilliamBossard/Gens-Launcher' }
    ],

    footer: {
      message: 'Released under the MIT License. Developed for the Gens Ecosystem.',
      copyright: 'Copyright © 2026 William Bossard'
    }
  }
})
