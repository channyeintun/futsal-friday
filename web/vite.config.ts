import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    // Proxying the API in development keeps the app same-origin, which sidesteps
    // CORS and lets the mirrored auth cookie work exactly as it would behind a
    // custom domain in production.
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        // Server-sent events must not be buffered by the proxy.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },

  build: {
    target: 'es2022',
    // The app is opened inside a chat webview on a phone; a small, single
    // bundle beats clever chunking at this size.
    chunkSizeWarningLimit: 700,
  },
});
