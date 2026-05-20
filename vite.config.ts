import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const isDev = process.env.NODE_ENV === 'development'

// https://vite.dev/config/
export default defineConfig({
  base: isDev ? '/' : '/fabric-sticker/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
