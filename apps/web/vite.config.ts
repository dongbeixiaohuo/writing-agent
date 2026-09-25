import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL(`./dist/${mode === 'mock' ? 'mock' : mode === 'extension-demo' ? 'extension-demo' : 'production'}/`, import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    ...(mode === 'extension-demo' ? {
      rollupOptions: {
        input: fileURLToPath(new URL('./extension-demo.html', import.meta.url)),
      },
    } : {}),
  },
  server: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
  },
}))
