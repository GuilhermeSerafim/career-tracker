import { createAuthenticator } from './auth.js';
import { createDatabase } from './database.js';
import { readServerConfig } from './config.js';
import { createApp } from './app.js';
import { unavailable } from './unavailable.js';
import { publicAuthOrigin } from './security-policy.js';

/** Sem verifier injetável por ambiente: produção sempre valida getUser remoto. */
export function createRuntimeApp(env: NodeJS.ProcessEnv = process.env) {
  try {
    // Previews públicos não recebem acesso a banco; provisionamento real é separado.
    if (env.VERCEL_ENV === 'preview') return { handler: unavailable, close: async () => undefined };
    // Configuração oficial do runtime Node da Vercel; sem helpers de body pré-parseado.
    if (env.VERCEL === '1' && env.NODEJS_HELPERS !== '0')
      return { handler: unavailable, close: async () => undefined };
    const config = readServerConfig(env);
    const origin = publicAuthOrigin(
      env.VITE_SUPABASE_URL,
      ['test', 'development'].includes(env.NODE_ENV ?? ''),
    );
    if ((!origin && env.VERCEL === '1') || (origin && origin !== config.supabaseUrl))
      return { handler: unavailable, close: async () => undefined };
    const database = createDatabase(config);
    return {
      handler: createApp({ database, authenticate: createAuthenticator(config, database) }),
      close: () => database.close(),
    };
  } catch {
    return { handler: unavailable, close: async () => undefined };
  }
}
