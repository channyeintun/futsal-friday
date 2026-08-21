import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig, loadEnv } from 'vite';

/**
 * Warm the connection to the API before anything asks for it.
 *
 * In production the Worker is a different origin from the app — Pages on one
 * host, the API on `*.workers.dev` — so the first request to it pays for a DNS
 * lookup, a TCP handshake and a TLS handshake before a byte of the answer moves.
 * That is three round trips, and the app makes that request the moment it boots
 * to find out who you are. Starting them from the document's `<head>` overlaps
 * all three with downloading and parsing the bundle, which is otherwise dead
 * time on the connection.
 *
 * `use-credentials`, not the bare `crossorigin` that a font would use: every
 * call this app makes carries credentials, and a socket opened anonymously is
 * not the one a credentialed request will reuse. Getting that wrong costs an
 * idle connection and buys nothing.
 *
 * Injected here rather than written into `index.html` because it must not
 * appear in development, where `VITE_API_URL` is unset, the API is proxied
 * through the dev server, and the app is same-origin — there would be nothing
 * to preconnect to but the page itself.
 */
function preconnectApi(mode: string): Plugin {
  return {
    name: 'ff-preconnect-api',
    transformIndexHtml(html) {
      const url = loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL;
      if (!url) return html;
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        return html;
      }
      return html.replace(
        '</title>',
        `</title>\n\n    <!-- The API is a different origin in production; see vite.config.ts. -->\n` +
          `    <link rel="dns-prefetch" href="${origin}" />\n` +
          `    <link rel="preconnect" href="${origin}" crossorigin="use-credentials" />`,
      );
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), preconnectApi(mode)],

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
}));
