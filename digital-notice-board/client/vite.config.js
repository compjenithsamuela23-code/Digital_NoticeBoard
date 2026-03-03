import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    modulePreload: {
      polyfill: true,
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('react') || id.includes('scheduler')) return 'vendor-react'
          if (id.includes('react-router-dom')) return 'vendor-router'
          if (
            id.includes('pdfjs-dist') ||
            id.includes('xlsx') ||
            id.includes('mammoth') ||
            id.includes('jszip')
          ) {
            return 'vendor-docs'
          }
          if (id.includes('socket.io-client') || id.includes('axios')) return 'vendor-network'
          if (id.includes('framer-motion') || id.includes('lucide-react')) return 'vendor-ui'
          return 'vendor-misc'
        },
      },
    },
  },
})
