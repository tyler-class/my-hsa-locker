import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { sourceDefines } from './scripts/kit/source';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * pdf.js's data files (standard fonts, CMaps, ICC profiles, image-decoder wasm), served at
 * /pdfjs/ in dev and copied there in the build. Fetched only when a PDF needs them; never
 * precached (the service worker's globs skip these types).
 */
function pdfjsAssets(): Plugin {
  const root = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url));
  const keep = new Set(['.wasm', '.pfb', '.ttf', '.bcmap', '.icc']);
  const files = ['wasm', 'standard_fonts', 'cmaps', 'iccs'].flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((f) => keep.has(extname(f)) && !f.startsWith('quickjs'))
      .map((f) => `${dir}/${f}`),
  );
  const types: Record<string, string> = { '.wasm': 'application/wasm' };
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs/', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]!.replace(/^\//, ''));
        if (!files.includes(rel)) return next();
        res.setHeader('Content-Type', types[extname(rel)] ?? 'application/octet-stream');
        res.end(readFileSync(join(root, rel)));
      });
    },
    generateBundle() {
      if (this.environment.name !== 'client') return;
      for (const f of files)
        this.emitFile({
          type: 'asset',
          fileName: `pdfjs/${f}`,
          source: readFileSync(join(root, f)),
        });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare(),
    pdfjsAssets(),
    VitePWA({
      // 'prompt' so lib/pwa.ts decides when to switch (never mid-form); it reloads on its own.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'HSA Locker',
        short_name: 'HSA Locker',
        description: 'Every medical receipt for your HSA, in one place.',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        theme_color: '#f6f5f0',
        background_color: '#f6f5f0',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Push notifications and the app-icon badge (Selfhost Kit: public/kit-push-sw.js).
        importScripts: ['kit-push-sw.js'],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // pdf.js loads on demand and only online (files are never cached), so it isn't precached.
        globIgnores: ['**/pdfjs-*.js'],
        // Pages are network-first (below), so a deploy shows up on the next load instead of
        // after the service worker updates. index.html stays precached only as the offline copy.
        navigateFallback: null,
        directoryIndex: null,
        cleanupOutdatedCaches: true,
        // Take over on first install (offline from the first visit). Updates still wait for
        // lib/pwa.ts to say when (skipWaiting is sent as a message).
        clientsClaim: true,
        runtimeCaching: [
          {
            // App pages (not the API, sign-in, MCP or uploads): newest from the network, the last
            // copy or the precached index.html when offline.
            urlPattern: ({ request, url }) =>
              request.mode === 'navigate' &&
              !/^\/(api|mcp|authorize|oauth|\.well-known|upload)(\/|$)/.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'hsa-locker-pages',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 10 },
              cacheableResponse: { statuses: [200] },
              precacheFallback: { fallbackURL: '/index.html' },
            },
          },
          {
            // The summary and ledger stay readable offline. Document files are never cached.
            urlPattern: ({ url, request }) =>
              request.method === 'GET' &&
              (url.pathname === '/api/state' || url.pathname === '/api/summary'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'hsa-locker-api',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 10, maxAgeSeconds: 30 * 86400 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  define: { __APP_VERSION__: JSON.stringify(pkg.version), ...sourceDefines() },
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
  },
});
