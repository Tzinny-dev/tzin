import { defineComponent, h, onMounted, watch } from 'vue'
import type { Theme } from 'vitepress'
import { useRoute } from 'vitepress'
import DefaultTheme from 'vitepress/theme'

// GA4 vía gtag.js solo envía `page_view` en la carga inicial.
// Como VitePress navega como SPA (sin recargar), este componente invisible
// emite un `page_view` manual en cada cambio de ruta. Si GA no está cargado
// (dev local o GA_ID sin definir) es un no-op.
const GaPageView = defineComponent({
  name: 'GaPageView',
  setup() {
    // onMounted solo corre en el cliente: a prueba de SSR.
    onMounted(() => {
      const route = useRoute()
      watch(
        () => route.path,
        (path) => {
          const gtag = (
            window as unknown as {
              gtag?: (command: string, ...args: unknown[]) => void
            }
          ).gtag
          gtag?.('event', 'page_view', { page_path: path })
        }
      )
    })
    return () => null
  }
})

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'layout-top': () => h(GaPageView)
    })
} satisfies Theme
