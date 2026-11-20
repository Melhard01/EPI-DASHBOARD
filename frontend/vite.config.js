import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The dashboard and the backend are separate applications. In development the
// Vite server proxies /api to the backend, which keeps the browser on ONE origin
// (exactly like production, where the same hostname routes /api to the backend)
// so no CORS is needed and the code is identical in both environments.
export default defineConfig(({ mode }) => {
  // Variables WITHOUT the VITE_ prefix are read here, in Node, and are never
  // bundled into the browser code.
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.DEV_API_TARGET || 'http://localhost:3000';

  // Development only: Cloudflare Access adds this header at the edge in
  // production. Locally the proxy plays that role, using a token from
  // `npm run dev:token` in the backend. The token never reaches the browser.
  const devAccessToken = env.DEV_ACCESS_TOKEN;
  const proxy = {
    '/api': {
      target: apiTarget,
      changeOrigin: false,
      headers: devAccessToken ? { 'cf-access-jwt-assertion': devAccessToken } : {},
    },
  };

  return {
    plugins: [react(), tailwindcss()],
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 4173, strictPort: true, proxy },
    build: { sourcemap: false, target: 'es2022' },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./tests/setup.js'],
      include: ['tests/**/*.test.{js,jsx}'],
      exclude: ['tests/integration/**', 'node_modules/**'],
      css: false,
    },
  };
});
