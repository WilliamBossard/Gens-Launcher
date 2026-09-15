import DefaultTheme from 'vitepress/theme'
import InstallTabs from './components/InstallTabs.vue'
import LauncherMockup from './components/LauncherMockup.vue'
import GensCoreBanner from './components/GensCoreBanner.vue'
import ScreenshotGrid from './components/ScreenshotGrid.vue'
import FaqAccordion from './components/FaqAccordion.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app, router }: { app: any; router: any }) {
    app.component('InstallTabs', InstallTabs)
    app.component('LauncherMockup', LauncherMockup)
    app.component('GensCoreBanner', GensCoreBanner)
    app.component('ScreenshotGrid', ScreenshotGrid)
    app.component('FaqAccordion', FaqAccordion)

    if (typeof window !== 'undefined') {
      const originalOnAfterRouteChanged = router.onAfterRouteChanged
      router.onAfterRouteChanged = (to: string) => {
        if (originalOnAfterRouteChanged) {
          originalOnAfterRouteChanged(to)
        }
        const isFr = to.includes('/fr/') || to.endsWith('/fr') || to.endsWith('/fr.html')
        try {
          localStorage.setItem('genslauncher_lang', isFr ? 'fr' : 'en')
        } catch (e) {}
      }
    }
  }
}
