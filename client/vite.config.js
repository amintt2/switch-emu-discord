import { defineConfig } from 'vite';

// En dev, Vite renvoie /api et /relais vers le serveur local.
export default defineConfig({
  server: {
    port: 5173,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', ws: true, changeOrigin: true },
      '/relais': { target: 'http://127.0.0.1:3000', ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
