import type { AuthPort } from '../lib/auth';
import { createAuthController } from '../lib/auth';
import { createAppQueryClient } from './query';
import { createApiClient } from '../lib/api';
import { createTransferClient } from '../features/settings/transfer-client';

export function createAppRuntime(port: AuthPort, transport?: typeof fetch) {
  const query = createAppQueryClient();
  const auth = createAuthController(port, query);
  // Observe recovery before the SDK's asynchronous initialization consumes its URL.
  const disconnect = auth.connect();
  const api = createApiClient(auth, transport);
  const transfers = createTransferClient(auth, transport);
  const drafts = new Map<string, { dispose(): void }>();
  const clearDrafts = () => { drafts.forEach((draft) => draft.dispose()); drafts.clear(); };
  let generation = auth.getSnapshot().generation;
  let authenticated = auth.getSnapshot().status === 'authenticated';
  let accessPeriod = Number(authenticated);
  let disposed = false;
  let teardown: Promise<void> | undefined;
  const unsubscribe = auth.subscribe(() => {
    const next = auth.getSnapshot();
    // Track every Auth transition synchronously, even if React batches an
    // expiration and same-owner reentry without rendering the login state.
    if (next.status === 'authenticated' && (!authenticated || next.generation !== generation)) accessPeriod++;
    authenticated = next.status === 'authenticated';
    if (next.generation !== generation) {
      generation = next.generation; clearDrafts();
    }
  });
  return { auth, query, api, transfers,
    /** Authorization freshness is independent of retained business draft identity. */
    getAccessPeriod: () => accessPeriod,
    /** Draft owners live here, above route/login mounts. Never use for credentials. */
    retainDraft: <T extends { dispose(): void }>(key: string, create: () => T): T => {
      if (disposed || auth.getSnapshot().status !== 'authenticated') throw new Error('Entre na sua conta para editar.');
      if (!drafts.has(key)) drafts.set(key, create());
      return drafts.get(key) as T;
    },
    abandonDraft: (key: string) => { drafts.get(key)?.dispose(); drafts.delete(key); },
    /** Unmount React before deliberate runtime abandonment/replacement. Await before creating another
     * runtime: logout blocks/purges now, then drains pending credential work. */
    dispose: () => {
      if (!teardown) {
        disposed = true;
        teardown = (async () => {
          try { await auth.logout(); }
          finally { clearDrafts(); transfers.dispose(); unsubscribe(); disconnect(); query.clear(); await port.dispose?.(); }
        })();
      }
      return teardown;
    },
  };
}
export type AppRuntime = ReturnType<typeof createAppRuntime>;
