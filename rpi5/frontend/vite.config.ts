import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: [
        'ortophoto.jpg',
        'valvola.svg',
        'water_drop.svg',
        'orto-digitale-title.png',
      ],
      manifest: {
        name: 'Orto Digitale',
        short_name: 'Orto',
        description: 'Controllo irrigazione orto residenziale',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: '#f4efe6',
        theme_color: '#5b6f47',
        lang: 'it',
        categories: ['utilities', 'productivity'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/api/sensors/last') ||
              url.pathname.startsWith('/api/valve/state') ||
              url.pathname.startsWith('/api/weather/now-v2') ||
              url.pathname.startsWith('/api/weather/forecast-v2') ||
              url.pathname.startsWith('/api/weather/now') ||
              url.pathname.startsWith('/api/system/health') ||
              url.pathname.startsWith('/api/system/stats'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'live-data',
              networkTimeoutSeconds: 3,
              expiration: { maxAgeSeconds: 60 * 60, maxEntries: 50 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/api/sensors/trend') ||
              url.pathname.startsWith('/api/valve/intervals') ||
              url.pathname.startsWith('/api/valve/cumulative') ||
              url.pathname.startsWith('/api/weather/forecast'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'historical-data',
              expiration: { maxAgeSeconds: 60 * 60 * 24, maxEntries: 100 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'images',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 30, maxEntries: 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) =>
              url.origin === 'https://fonts.googleapis.com' ||
              url.origin === 'https://fonts.gstatic.com',
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 365, maxEntries: 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'https://orto.local',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
  },
});
