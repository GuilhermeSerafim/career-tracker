import type pg from 'pg';
import { z } from 'zod';

export interface ServerConfig {
  ownerUserId: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  database: pg.PoolConfig;
}

export class ConfigurationError extends Error {
  constructor() { super('Configuração inválida ou incompleta. Confira as variáveis privadas do servidor.'); }
}

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  try {
    const ownerUserId = z.uuid().parse(env.OWNER_USER_ID).toLowerCase();
    const supabaseUrl = new URL(env.SUPABASE_URL ?? '');
    const local = ['127.0.0.1', 'localhost', '[::1]'];
    const localEnvironment = ['test', 'development'].includes(env.NODE_ENV ?? '');
    if (supabaseUrl.username || supabaseUrl.password || supabaseUrl.search || supabaseUrl.hash || supabaseUrl.pathname !== '/') throw new ConfigurationError();
    if (supabaseUrl.protocol !== 'https:' && !(localEnvironment && local.includes(supabaseUrl.hostname) && supabaseUrl.protocol === 'http:')) throw new ConfigurationError();
    const supabasePublishableKey = env.SUPABASE_PUBLISHABLE_KEY ?? '';
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(supabasePublishableKey)) throw new ConfigurationError();
    const url = new URL(env.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) throw new ConfigurationError();
    const user = decodeURIComponent(url.username);
    if (!/^career_api(?:\.[a-z0-9-]+)?$/.test(user)) throw new ConfigurationError();
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!password || !database || database.includes('/') || !url.hostname) throw new ConfigurationError();
    const port = Number(url.port || '5432');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigurationError();
    const disableLocal = env.DATABASE_TLS === 'disable-local';
    if (disableLocal && !(localEnvironment && local.includes(url.hostname))) throw new ConfigurationError();
    if (!disableLocal && env.DATABASE_TLS !== 'verify-full') throw new ConfigurationError();
    if (!localEnvironment && env.DATABASE_POOL_MODE !== 'transaction') throw new ConfigurationError();
    const max = Number(env.DATABASE_POOL_MAX ?? '3');
    if (!Number.isInteger(max) || max < 1 || max > 5) throw new ConfigurationError();
    return {
      ownerUserId, supabaseUrl: supabaseUrl.origin, supabasePublishableKey,
      database: {
        host: url.hostname === '[::1]' ? '::1' : url.hostname, port, database, user, password,
        ssl: disableLocal ? false : { rejectUnauthorized: true, ...(env.DATABASE_CA_CERT ? { ca: env.DATABASE_CA_CERT } : {}) },
        max, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5000,
        statement_timeout: 15_000, idle_in_transaction_session_timeout: 15_000,
        application_name: 'career-tracker-api',
      },
    };
  } catch { throw new ConfigurationError(); }
}
