import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { PAGE_HEADER_CSP, pageMetaCsp, publicAuthOrigin } from './server/security-policy.ts';

export default defineConfig(({ mode }) => {
  // loadEnv só lê o prefixo público. Nenhuma credencial do servidor entra no HTML.
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const origin = publicAuthOrigin(env.VITE_SUPABASE_URL, process.env.VERCEL !== '1');
  if (process.env.VERCEL === '1' && !origin)
    throw Error('Configure a origem pública de autenticação antes da publicação.');
  if (
    process.env.VERCEL_ENV === 'production' &&
    publicAuthOrigin(process.env.SUPABASE_URL, false) !== origin
  )
    throw Error('As origens pública e privada de autenticação devem coincidir.');
  return {
    plugins: [
      react(),
      {
        name: 'private-page-csp',
        apply: 'build',
        transformIndexHtml: {
          order: 'post',
          handler: (html) =>
            html.replace(
              /<head>/i,
              '<head>\n    <meta http-equiv="Content-Security-Policy" content="' +
                pageMetaCsp(origin) +
                '" />',
            ),
        },
      },
    ],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': 'http://127.0.0.1:3001' },
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      proxy: { '/api': 'http://127.0.0.1:3001' },
      headers: {
        'Content-Security-Policy': PAGE_HEADER_CSP,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  };
});
