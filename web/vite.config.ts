import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => ({
  plugins: [react(), tailwindcss()],
  // The dev server is always in presenter mode: it takes PRESENTER_KEY from the repo's .env.
  // Production builds never embed the key; the public site stays gated.
  define: {
    __DEV_PRESENTER_KEY__: JSON.stringify(command === 'serve' ? (loadEnv(mode, path.resolve(import.meta.dirname, '..'), '').PRESENTER_KEY ?? '') : ''),
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // VITE_API_TARGET=https://… points the dev proxy at a deployed API.
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:8000',
        changeOrigin: true,
        secure: true,
      },
    },
  },
}))
