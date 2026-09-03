import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.SOPDS_API || 'http://localhost:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on all interfaces so the dev UI is reachable from other devices
    // (e-readers, tablets) on the LAN.
    host: true,
    port: 5173,
    proxy: {
      '/api': API_TARGET,
      '/opds': API_TARGET,
    },
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    outDir: 'dist',
  },
});
