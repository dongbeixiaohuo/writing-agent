import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), plugins: [react()],
  optimizeDeps: { entries: ['run-trace-inspector.html'] },
  server: { host: '127.0.0.1', port: 4195, strictPort: true, fs: { allow: [process.cwd()] } } });
