import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Proxy API calls to the Node server so the browser never talks to Databricks directly
// and no token ever reaches the client bundle.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
    },
  },
})
