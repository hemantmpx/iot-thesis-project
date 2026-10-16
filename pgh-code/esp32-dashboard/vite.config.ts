import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'   // <-- you need this for path.resolve

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5000', // Flask backend
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
    allowedHosts: [
      'share-emperor-mats-slope.trycloudflare.com', // allow your Cloudflare tunnel host
      '.trycloudflare.com', // optional: allow any tunnel subdomain
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
