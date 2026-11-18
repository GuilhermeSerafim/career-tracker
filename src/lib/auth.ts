import { createClient, navigatorLock, processLock } from '@supabase/supabase-js';
import type { AuthChangeEvent, Session, LockFunc } from '@supabase/supabase-js';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';

export interface AuthPort {
  onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void): { data: { subscription: { unsubscribe(): void } } };
  signInWithPassword(input: { email: string; password: string }, context: CredentialOperation): Promise<{ error: unknown }>;
  resetPasswordForEmail(email: string, options: { redirectTo: string }): Promise<{ error: unknown }>;
  updateUser(input: { password: string }, context: PasswordOperation): Promise<{ error: unknown }>;
  captureLogout?(session: Session | null): LogoutOperation;
  signOut(context?: LogoutOperation): Promise<{ error: unknown }>;
  dispose?(): Promise<void>;
}
export interface CredentialOperation { isCurrent(): boolean }
export interface PasswordOperation extends CredentialOperation { session: Session }
export interface LogoutOperation { session: Session | null; storageGeneration?: string; recoveryGeneration?: string }
type SyncSessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Ownership = { version: 1; generation: string; revision: string; origin: 'legacy' | 'established'; blocked: boolean };
type StoredSession = Session & { careerTracker?: unknown };
const observedOwnership = new WeakMap<Session, Ownership>();
const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const sameCredentials = (left: Session | null, right: Session) => left?.access_token === right.access_token && left?.refresh_token === right.refresh_token;
// session_id survives refresh rotation but changes on a fresh login. This is
// only an SDK-storage ownership fence, never an authorization/JWT verifier.
function loginIdentity(token: string): string | null {
    try {
      const payload = token.split('.')[1]!;
      const id: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).session_id;
      return isUuid(id) ? id : null;
    } catch { return null; }
}
function sameLoginSession(left: Session | null, right: Session): boolean {
  if (sameCredentials(left, right)) return true;
  if (!left || left.user.id !== right.user.id) return false;
  const original = loginIdentity(left.access_token);
  return original !== null && original === loginIdentity(right.access_token);
}
function distinctLogin(left: Session, right: Session): boolean {
  if (left.user.id !== right.user.id) return true;
  const previousOwnership = observedOwnership.get(left); const nextOwnership = observedOwnership.get(right);
  if (previousOwnership && nextOwnership?.origin === 'established' && previousOwnership.generation !== nextOwnership.generation) return true;
  const original = loginIdentity(left.access_token); const next = loginIdentity(right.access_token);
  return original !== null && next !== null && original !== next;
}

/** Supported browser StorageAdapter. Atomic ownership metadata shares the SDK
 * session slot; the injected lock must also be supplied to the main SDK client. */
export function createSdkSessionStorage(base: SyncSessionStorage, storageKey: string, lock: LockFunc = processLock) {
  let pending: { candidate: Session; context: CredentialOperation; ownership: Ownership } | null = null;
  let recoveryWrite: { revision: string; consumed: boolean; pkce?: { generation: string; epoch: number } } | null = null;
  let operationEpoch = 0;
  type SdkOperation = { epoch: number; pkce: boolean; verifiers: Map<string, string | null>; ownership?: Ownership };
  let sdkOperation: SdkOperation | null = null;
  const lockName = `lock:${storageKey}`;
  const legacyVerifier = `${storageKey}-code-verifier`; const verifierIndex = `${storageKey}-flows-code-verifier`;
  const isVerifier = (key: string) => key === legacyVerifier || key.startsWith(`${storageKey}-flow-`) && key.endsWith('-code-verifier') && /^[a-zA-Z0-9_-]{8,64}$/.test(key.slice(storageKey.length + 6, -14));
  const supersededPkce = () => sdkOperation?.pkce && sdkOperation.epoch !== operationEpoch;
  const fresh = (origin: Ownership['origin'], blocked = false): Ownership => ({ version: 1, generation: crypto.randomUUID(), revision: crypto.randomUUID(), origin, blocked });
  const parse = (text: string): StoredSession => {
    const value = JSON.parse(text) as StoredSession;
    if (!value || typeof value.access_token !== 'string' || typeof value.refresh_token !== 'string' || typeof value.user?.id !== 'string') throw Error('Armazenamento de acesso inválido.');
    return value;
  };
  const read = () => {
    const text = base.getItem(storageKey); if (text === null) return null;
    const value = parse(text); const marker = value.careerTracker;
    if (marker === undefined && !Object.hasOwn(value, 'careerTracker')) return { value, ownership: null };
    const candidate = marker as Partial<Ownership> | null;
    if (!candidate || candidate.version !== 1 || !isUuid(candidate.generation) || !isUuid(candidate.revision) || !['legacy', 'established'].includes(candidate.origin ?? '') || typeof candidate.blocked !== 'boolean') throw Error('Identificação do acesso inválida.');
    return { value, ownership: candidate as Ownership };
  };
  const write = (value: Session, ownership: Ownership) => base.setItem(storageKey, JSON.stringify({ ...value, careerTracker: ownership }));
  const observe = (session: Session, event?: AuthChangeEvent) => {
    try {
      const current = read();
      if (!current || current.ownership?.blocked || !sameCredentials(current.value, session)) return false;
      const previous = observedOwnership.get(session);
      if (previous && previous.revision !== current.ownership?.revision) return false;
      if (current.ownership) observedOwnership.set(session, current.ownership);
      if (event !== 'INITIAL_SESSION' && recoveryWrite && recoveryWrite.revision === current.ownership?.revision) recoveryWrite.consumed = true;
      return true;
    } catch { return false; }
  };
  return {
    // Adopt legacy bytes only inside the exact SDK lock, never from getItem.
    lock: ((name, timeout, action) => {
      // Capture at the SDK lock request, before initialization/network/lock waits.
      // Verifier reads identify PKCE later, but cannot give it a newer epoch.
      const operation: SdkOperation = { epoch: operationEpoch, pkce: false, verifiers: new Map() };
      return lock(name, timeout, async () => {
        if (name !== lockName) return action();
        const previous = sdkOperation; sdkOperation = operation;
        try {
          let current: ReturnType<typeof read> = null;
          try { current = read(); } catch { /* Preserve corrupt bytes; reads fail closed. */ }
          if (current && !current.ownership) write(current.value, fresh('legacy'));
          return await action();
        } finally { sdkOperation = previous; }
      });
    }) as LockFunc,
    observe,
    // This SDK method writes verifiers without acquiring its own lock. Run it
    // after SDK work so a new reset never inherits an old PKCE write context.
    runReset: <T,>(action: () => Promise<T>) => lock(lockName, 5000, action),
    cancelRecoveryWrites: () => {
      const generation = recoveryWrite?.pkce?.epoch === operationEpoch ? recoveryWrite.pkce.generation : undefined;
      operationEpoch++; if (recoveryWrite) recoveryWrite.consumed = true;
      return generation;
    },
    establishRecovery: async (session: Session, context: CredentialOperation) => {
      // Only an actual, still-unconsumed SDK write can produce recovery. Capture
      // its revision synchronously; waiting must never adopt later bytes, even
      // when their token pair happens to be identical. Bookkeeping is not proof.
      const current = read(); const revision = current?.ownership?.revision;
      const previous = observedOwnership.get(session);
      if (!current || !sameCredentials(current.value, session) || !revision ||
          previous && previous.revision !== revision || !recoveryWrite || recoveryWrite.consumed || recoveryWrite.revision !== revision) return Promise.resolve(false);
      recoveryWrite.consumed = true;
      return lock(lockName, 5000, async () => {
        const latest = read();
        if (!context.isCurrent() || !latest || latest.ownership?.revision !== revision || !sameCredentials(latest.value, session)) return false;
        // Establishment and publication belong to the same persisted recovery.
        // Keep its generation so captured cleanup owns every handoff; only the
        // write revision changes here. A fresh PKCE operation owns its own ID.
        const ownership: Ownership = { ...latest.ownership!, origin: 'established', blocked: false, revision: crypto.randomUUID() };
        write(latest.value, ownership); observedOwnership.set(session, ownership);
        return true;
      });
    },
    clearCaptured: (captured: Session | null, generation = captured ? observedOwnership.get(captured)?.generation : undefined, recoveryGeneration?: string) => lock(lockName, 5000, async () => {
      if (!captured && !recoveryGeneration) return;
      const current = read(); if (!current) return;
      // Initialization may have saved once before its callback. Logout owns
      // that proven PKCE generation even while the controller still has null.
      if (recoveryGeneration && current.ownership?.generation === recoveryGeneration) { base.removeItem(storageKey); return; }
      if (!captured) return;
      if (generation && current.ownership?.generation === generation) { base.removeItem(storageKey); return; }
      if (generation && current.ownership?.origin === 'established' && current.ownership.generation !== generation) return;
      if (sameLoginSession(current.value, captured)) { base.removeItem(storageKey); return; }
      if (distinctLogin(captured, current.value)) return;
      // Indeterminate replacement: preserve its credentials but deny SDK reads
      // across reload. Only a verified fresh login/recovery can unblock it.
      write(current.value, { ...(current.ownership ?? fresh('legacy')), revision: crypto.randomUUID(), blocked: true });
    }),
    storage: {
      getItem: (key: string) => {
        if (sdkOperation && isVerifier(key)) {
          sdkOperation.pkce = true;
          if (supersededPkce()) return null;
          const value = base.getItem(key);
          if (!sdkOperation.verifiers.has(key)) sdkOperation.verifiers.set(key, value);
          return value;
        }
        if (key !== storageKey) return base.getItem(key);
        try {
          const current = read(); if (!current || current.ownership?.blocked) return null;
          const value = { ...current.value }; delete value.careerTracker;
          return JSON.stringify(value);
        } catch { return null; }
      },
      removeItem: (key: string) => {
        if (supersededPkce()) {
          if (key === storageKey || key === verifierIndex) return;
          if (isVerifier(key) && (!sdkOperation!.verifiers.has(key) || base.getItem(key) !== sdkOperation!.verifiers.get(key))) return;
        }
        base.removeItem(key);
      },
      setItem: (key: string, value: string) => {
        if (supersededPkce()) {
          if (key === storageKey) throw new Error('A recuperação de acesso foi substituída.');
          if (key === verifierIndex || isVerifier(key)) return;
        }
        if (key !== storageKey) { base.setItem(key, value); return; }
        const incoming = parse(value);
        if (pending && sameCredentials(incoming, pending.candidate)) {
          if (!pending.context.isCurrent()) throw new Error('A operação de acesso foi substituída.');
          write(incoming, pending.ownership); recoveryWrite = { revision: pending.ownership.revision, consumed: false }; return;
        }
        const current = read();
        // Fresh PKCE owns a distinct generation from its FIRST save, so older
        // cleanup cannot erase it while its notification is still pending.
        if (sdkOperation?.pkce) sdkOperation.ownership ??= fresh('established');
        const ownership = { ...(sdkOperation?.ownership ?? (current && distinctLogin(current.value, incoming) ? fresh('established') : current?.ownership ?? fresh('legacy'))), revision: crypto.randomUUID() };
        write(incoming, ownership);
        recoveryWrite = { revision: ownership.revision, consumed: false, ...(sdkOperation?.pkce ? { pkce: { generation: ownership.generation, epoch: sdkOperation.epoch } } : {}) };
      },
    },
    promote: async <T,>(candidate: Session, context: CredentialOperation, action: () => Promise<T>): Promise<T> => {
      if (pending || !context.isCurrent()) throw new Error('A operação de acesso foi substituída.');
      pending = { candidate, context, ownership: fresh('established') };
      try { return await action(); } finally { pending = null; }
    },
  };
}
/** Production construction must use createBrowserAuth, or pair this adapter
 * with the same createSdkSessionStorage/key supplied to the main SDK client.
 * A bare SDK client does not honor the credential-operation context contract. */
export function createSdkAuthPort(main: Omit<AuthPort, 'updateUser' | 'signInWithPassword' | 'signOut'> & {
  setSession(input: { access_token: string; refresh_token: string }): Promise<{ error: unknown }>;
}, options: { url: string; publishableKey: string; fetch?: typeof fetch; sessionStorage: ReturnType<typeof createSdkSessionStorage> }): AuthPort {
  let promotion: { candidate: Session; context: CredentialOperation } | null = null;
  let recoveryEpoch = 0;
  const isolatedClient = () => createClient(options.url, options.publishableKey, {
    auth: { storageKey: `career-tracker:credential:${crypto.randomUUID()}`, persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: options.fetch },
  }).auth;
  return {
    onAuthStateChange: (callback) => {
      let active = true;
      const subscription = main.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' && promotion && sameCredentials(session, promotion.candidate) && !promotion.context.isCurrent()) return;
        if (event === 'PASSWORD_RECOVERY' && session) {
          // The SDK can notify while holding its lock. Schedule, never await
          // another acquisition from that subscriber; compare again inside it.
          const epoch = recoveryEpoch;
          void options.sessionStorage.establishRecovery(session, { isCurrent: () => active && epoch === recoveryEpoch }).then(accepted => { if (active && accepted && epoch === recoveryEpoch) callback(event, session); }).catch(() => {});
          return;
        }
        if (session && !options.sessionStorage.observe(session, event)) return;
        callback(event, session);
      });
      return { data: { subscription: { unsubscribe: () => { active = false; subscription.data.subscription.unsubscribe(); } } } };
    },
    signInWithPassword: async (input, context) => {
      const isolated = isolatedClient();
      try {
        await isolated.initialize(); await isolated.stopAutoRefresh();
        if (!context.isCurrent()) return { error: new Error('A operação de acesso foi substituída.') };
        const result = await isolated.signInWithPassword(input);
        if (result.error || !result.data.session) return { error: result.error ?? new Error('Sessão indisponível.') };
        if (!context.isCurrent()) return { error: new Error('A operação de acesso foi substituída.') };
        promotion = { candidate: result.data.session, context };
        try {
          return await options.sessionStorage.promote(result.data.session, context, () => main.setSession(result.data.session!));
        } finally { promotion = null; }
      } finally { await isolated.dispose(); }
    },
    resetPasswordForEmail: (email, redirect) => options.sessionStorage.runReset(() => main.resetPasswordForEmail(email, redirect)),
    captureLogout: session => {
      recoveryEpoch++; const recoveryGeneration = options.sessionStorage.cancelRecoveryWrites();
      return { session, storageGeneration: session ? observedOwnership.get(session)?.generation : undefined, recoveryGeneration };
    },
    signOut: async (context) => {
      if (!context) return { error: new Error('A saída exige a sessão capturada.') };
      // The matched SDK lock fences actual removal, including a refresh already
      // in flight. A newer login before this lock or during remote revocation
      // must not be removed, broadcast out, or revoked globally.
      await options.sessionStorage.clearCaptured(context.session, context.storageGeneration, context.recoveryGeneration);
      if (!context.session) return { error: null };
      const isolated = isolatedClient();
      try { return await isolated.admin.signOut(context.session.access_token, 'local'); }
      finally { await isolated.dispose(); }
    },
    dispose: () => main.dispose?.() ?? Promise.resolve(),
    updateUser: async (input, context) => {
      const superseded = () => ({ error: new Error('A operação de acesso foi substituída. Tente novamente na sessão atual.') });
      if (!context.isCurrent()) return superseded();
      // updateUser saves its captured session before USER_UPDATED. Isolate that
      // SDK side effect instead of copying or repairing credentials after the fact.
      const isolated = isolatedClient();
      try {
        await isolated.initialize();
        await isolated.stopAutoRefresh(); // Also removes the SDK visibility listener.
        if (!context.isCurrent()) return superseded();
        const seeded = await isolated.setSession({ access_token: context.session.access_token, refresh_token: context.session.refresh_token });
        if (seeded.error || seeded.data.session?.user.id !== context.session.user.id || !context.isCurrent()) return superseded();
        const result = await isolated.updateUser(input);
        // A sent request may already have changed the remote password. This only
        // prevents its local completion from authorizing a superseded operation.
        return context.isCurrent() ? { error: result.error } : superseded();
      } finally { await isolated.dispose(); }
    },
  };
}
export interface AuthState {
  status: 'loading' | 'authenticated' | 'login' | 'recovery';
  session: Session | null;
  ownerId: string | null;
  generation: number;
}
export interface LogoutChannel {
  postMessage(message: 'logout'): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}
export interface LogoutSignal { subscribe(listener: () => void): () => void; publish(): void }
export function createLogoutSignal(factory?: () => LogoutChannel): LogoutSignal {
  const create = factory ?? (typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function'
    ? () => new window.BroadcastChannel('career-tracker:logout') : undefined);
  const listeners = new Set<() => void>();
  let channel: LogoutChannel | undefined;
  const receive = (event: MessageEvent) => { if (event.data === 'logout') listeners.forEach((listener) => listener()); };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (!channel && create) { channel = create(); channel.addEventListener('message', receive); }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { channel?.removeEventListener('message', receive); channel?.close(); channel = undefined; }
      };
    },
    publish: () => {
      if (channel) channel.postMessage('logout');
      else if (create) { const temporary = create(); temporary.postMessage('logout'); temporary.close(); }
    },
  };
}
/** Connect synchronously during bootstrap, before yielding after SDK creation,
 * so PASSWORD_RECOVERY is observed before URL consumption completes. Keep the
 * returned disconnect for runtime teardown; useAuth shares that subscription. */
export function createAuthController(port: AuthPort, cache: QueryClient, logoutSignal: LogoutSignal = createLogoutSignal()) {
  let state: AuthState = { status: 'loading', session: null, ownerId: null, generation: 0 };
  const listeners = new Set<() => void>();
  let consumers = 0;
  let subscription: { unsubscribe(): void } | undefined;
  let connection = 0;
  let blocked = false;
  let loggedOutSession: Session | null = null;
  let logoutWork: { promise: Promise<void>; blockedGeneration: number } | null = null;
  const authWrites = new Set<Promise<void>>();
  let unsubscribeLogout = () => {};
  const publish = (next: AuthState) => { state = next; listeners.forEach((listener) => listener()); };
  const purge = () => { void cache.cancelQueries(); cache.clear(); };
  const expire = () => publish({ ...state, status: 'login', session: null });
  const blockAndPurge = () => {
    blocked = true; purge();
    publish({ status: 'login', session: null, ownerId: null, generation: state.generation + 1 });
  };
  const perform = async (action: () => Promise<{ error: unknown }>, message: string) => {
    try { if ((await action()).error) throw new Error(); }
    catch { throw new Error(message); }
  };
  const trackWrite = (action: () => Promise<{ error: unknown }>, message: string) => {
    const task = perform(action, message).finally(() => { authWrites.delete(task); });
    authWrites.add(task);
    return task;
  };
  const logout = (broadcast: boolean): Promise<void> => {
    if (logoutWork && blocked && state.generation === logoutWork.blockedGeneration) return logoutWork.promise;
    const captured = state.session;
    let capture: LogoutOperation = { session: captured, storageGeneration: captured ? observedOwnership.get(captured)?.generation : undefined };
    let captureFailed = false;
    try { capture = port.captureLogout?.(captured) ?? capture; } catch { captureFailed = true; }
    loggedOutSession = captured;
    blockAndPurge();
    // In-flight SDK sign-in/update can write SDK storage. Let them settle while
    // blocked, then sign out, so a late completion cannot restore persisted access.
    const outstanding = [...authWrites];
    const task = (async () => {
      await Promise.allSettled(outstanding);
      await perform(() => { if (captureFailed) throw Error(); return port.signOut(capture); }, 'A sessão local foi encerrada. Não foi possível confirmar a saída no serviço.');
    })().finally(() => { if (logoutWork?.promise === task) logoutWork = null; });
    logoutWork = { promise: task, blockedGeneration: state.generation };
    if (broadcast) logoutSignal.publish();
    return task;
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect: () => {
      consumers++;
      if (!subscription) {
        unsubscribeLogout = logoutSignal.subscribe(() => { void logout(false).catch(() => {}); });
        const activeConnection = ++connection;
        let observedEvent = false;
        subscription = port.onAuthStateChange((event, session) => {
          if (activeConnection !== connection) return;
          if (blocked) {
            // Stale refresh/initialization/recovery and same-login callbacks
            // cannot restore access. Candidate writes also retain their own
            // generation guard in the adapter above.
            if (!['SIGNED_IN', 'PASSWORD_RECOVERY'].includes(event) || !session || loggedOutSession && !distinctLogin(loggedOutSession, session)) return;
            blocked = false;
          }
          // An initialization result must never replace a newer observed Auth event.
          if (event === 'INITIAL_SESSION' && observedEvent) return;
          observedEvent = true;
          if (!session) { expire(); return; }
          if (event === 'USER_UPDATED' && (!state.session || state.ownerId !== session.user.id)) return;
          if (event === 'TOKEN_REFRESHED' && state.ownerId && state.ownerId !== session.user.id) return;
          // First identity establishment also supersedes credential work that
          // began signed out; absence of an owner is not continuing authority.
          const changedOwner = state.ownerId !== session.user.id;
          if (changedOwner) purge();
          publish({ status: event === 'PASSWORD_RECOVERY' || !changedOwner && state.status === 'recovery' ? 'recovery' : 'authenticated',
            session, ownerId: session.user.id, generation: state.generation + Number(changedOwner) });
        }).data.subscription;
      }
      let connected = true;
      return () => {
        if (!connected) return;
        connected = false;
        if (--consumers === 0) { connection++; subscription?.unsubscribe(); subscription = undefined; unsubscribeLogout(); }
      };
    },
    expire,
    login: async (email: string, password: string) => {
      if (logoutWork || authWrites.size) throw new Error('Aguarde a conclusão da operação de acesso e tente novamente.');
      blocked = false;
      const generation = state.generation;
      await trackWrite(() => port.signInWithPassword({ email, password }, { isCurrent: () => state.generation === generation && !blocked }), 'Não foi possível entrar. Confira suas credenciais e tente novamente.');
    },
    requestRecovery: async (email: string) => {
      // Never copy the current callback query/hash (which can contain secrets).
      const redirectTo = new URL('/recuperar-senha', window.location.origin).href;
      await perform(() => port.resetPasswordForEmail(email, { redirectTo }), 'Não foi possível solicitar a recuperação. Tente novamente.');
    },
    updatePassword: async (password: string) => {
      if (logoutWork || authWrites.size || state.status !== 'recovery' || !state.session) throw new Error('Abra o link de recuperação para alterar sua senha.');
      const generation = state.generation;
      const session = { ...state.session, user: { ...state.session.user } };
      const isCurrent = () => generation === state.generation && !blocked && state.status === 'recovery' && state.session?.user.id === session.user.id;
      await trackWrite(() => port.updateUser({ password }, { session, isCurrent }), 'Não foi possível alterar a senha. Tente novamente.');
      if (isCurrent()) publish({ ...state, status: 'authenticated' });
    },
    logout: () => {
      // SIGNED_OUT has no reason field in the SDK. Only this explicit action purges
      // drafts; unsolicited SIGNED_OUT blocks access while preserving tab memory.
      return logout(true);
    },
  };
}
export type AuthController = ReturnType<typeof createAuthController>;

/** Mount above protected routes, so expiration does not destroy draft owners. */
export function useAuth(auth: AuthController) {
  useEffect(() => auth.connect(), [auth]);
  return useSyncExternalStore(auth.subscribe, auth.getSnapshot, auth.getSnapshot);
}

export function createBrowserAuth() {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
  if (!url || !key?.startsWith('sb_publishable_')) throw new Error('Autenticação indisponível. Verifique a configuração pública.');
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) {
    throw new Error('Autenticação indisponível. Verifique a configuração pública.');
  }
  const storageKey = `sb-${parsed.hostname.split('.')[0]}-auth-token`; // Preserve the SDK's default session/verifier slot.
  let base: SyncSessionStorage;
  try { base = window.localStorage; }
  catch {
    const values = new Map<string, string>();
    base = { getItem: (name) => values.get(name) ?? null, setItem: (name, value) => { values.set(name, value); }, removeItem: (name) => { values.delete(name); } };
  }
  const sessionStorage = createSdkSessionStorage(base, storageKey, navigator.locks ? navigatorLock : processLock);
  const main = createClient(url, key, { auth: { storageKey, storage: sessionStorage.storage, lock: sessionStorage.lock, flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }).auth;
  return createSdkAuthPort(main, { url, publishableKey: key, sessionStorage });
}
