// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  modules: [
    '@nuxtjs/tailwindcss'
  ],

  app: {
    head: {
      title: 'Cortana Monitor',
      meta: [
        { name: 'description', content: 'Monitor PWA para publicaciones recientes de Facebook.' },
        { name: 'theme-color', content: '#0f172a' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' }
      ],
      link: [
        { rel: 'manifest', href: '/manifest.webmanifest' },
        { rel: 'apple-touch-icon', href: '/icon.svg' }
      ]
    }
  },

  tailwindcss: {
    cssPath: '~/assets/css/main.css',
    configPath: 'tailwind.config.ts',
    exposeConfig: false,
    viewer: false
  },

  devServer: {
    host: 'localhost',
    port: 3010
  },

  vite: {
    server: {
      hmr: {
        port: 24679
      }
    }
  }
})
