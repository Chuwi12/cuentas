import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// /api se reenvía al backend de Rust: el navegador solo ve un origen,
// así la cookie httpOnly de sesión funciona sin CORS. API_TARGET cambia el destino.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': { target: process.env.API_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
})
