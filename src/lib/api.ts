import { useSyncExternalStore } from 'react';
import { commandSchema, MAX_COMMAND_BYTES } from '../../shared/commands';
import type { Command } from '../../shared/commands';
import type { AuthController } from './auth';

export class ApiError extends Error {
  constructor(readonly status: number, readonly requestId?: string, readonly details?: { currentVersion: number; changedFields: string[] }, readonly code?: 'ANALYTICS_SELECTION_STALE') {
    super(status === 401 ? 'Sua sessão expirou. Entre novamente para continuar.' : status === 403 ? 'Acesso não autorizado.' :
      status === 409 ? 'O registro foi alterado. Releia a versão atual e escolha as alterações.' : status === 503 ? 'Serviço indisponível. Sua edição foi mantida; tente novamente.' :
        status === 0 ? 'Esta operação foi encerrada.' : 'Não foi possível concluir a solicitação. Sua edição foi mantida.');
    this.name = 'ApiError';
  }
}
export interface CurrentVersion {
  versions: Readonly<Record<string, number>>;
  fields: Readonly<Record<string, string | number | boolean | null>>;
}
export type RefreshResult = { status: 'ready'; current: CurrentVersion } | { status: 'error'; error: ApiError } | { status: 'blocked' };
export function createApiClient(auth: AuthController, transport: typeof fetch = fetch) {
  const request = async <T,>(path: string, body?: string, key?: string): Promise<T> => {
    // No absolute URLs, fragments or redirects carrying a Bearer to another origin.
    if (!/^\/api\/v1\/[a-z0-9/-]+(?:\?[^#\\]*)?$/.test(path) || path.includes('..') || path.includes('//')) throw new ApiError(400);
    const identity = auth.getSnapshot();
    if (!identity.session || identity.status !== 'authenticated') throw new ApiError(401);
    const stillCurrent = () => auth.getSnapshot().generation === identity.generation && auth.getSnapshot().ownerId === identity.ownerId;
    let response: Response;
    let data: unknown;
    try {
      response = await transport(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { Authorization: `Bearer ${identity.session.access_token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key! }) }, body });
      if (!stillCurrent()) throw new ApiError(0);
    } catch (error) { throw error instanceof ApiError ? error : new ApiError(stillCurrent() ? 503 : 0); }
    try { data = await response.json(); }
    catch { if (response.ok) throw new ApiError(stillCurrent() ? 503 : 0); }
    if (!stillCurrent()) throw new ApiError(0);
    if (!response.ok) {
      const envelope = data && typeof data === 'object' && 'error' in data ? data.error : null;
      const safe = envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : {};
      const requestId = typeof safe.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(safe.requestId) ? safe.requestId : undefined;
      const details = safe.details as Record<string, unknown> | undefined;
      const conflict = response.status === 409 && safe.code === 'CONFLICT' && details && Number.isSafeInteger(details.currentVersion) && Number(details.currentVersion) > 0 &&
        Array.isArray(details.changedFields) && details.changedFields.length <= 100 && details.changedFields.every((field) => typeof field === 'string' && /^[a-zA-Z0-9_.]{1,80}$/.test(field))
        ? { currentVersion: details.currentVersion as number, changedFields: details.changedFields as string[] } : undefined;
      // A late 401 from an older token must not expire a refreshed session.
      if (response.status === 401 && auth.getSnapshot().session?.access_token === identity.session.access_token) auth.expire();
      const code = response.status === 409 && safe.code === 'ANALYTICS_SELECTION_STALE' ? safe.code : undefined;
      throw new ApiError(response.status, requestId, conflict, code);
    }
    return data as T;
  };
  return { read: <T,>(path: string) => request<T>(path), command: <T,>(body: string, key: string) => request<T>('/api/v1/commands', body, key) };
}
export type ApiClient = ReturnType<typeof createApiClient>;
export interface SaveState<C extends Command, T> {
  draft: C | null;
  status: 'editing' | 'saving' | 'saved' | 'unavailable' | 'login' | 'forbidden' | 'conflict' | 'refresh-required' | 'error' | 'disposed';
  current: CurrentVersion | null;
  result: T | null;
  error: ApiError | null;
}
export function createSaveIntent<C extends Command, T>(options: { auth: AuthController; api: ApiClient; draft: C; readCurrent: () => Promise<CurrentVersion> }) {
  const { auth, api, readCurrent } = options;
  let body: string | null = canonicalCommand(options.draft);
  let key: string | null = crypto.randomUUID();
  assertEnvelopeBudget(body, key);
  let state: SaveState<C, T> = { draft: JSON.parse(body) as C, status: 'editing', current: null, result: null, error: null };
  const listeners = new Set<() => void>();
  const generation = auth.getSnapshot().generation;
  let needsRefresh = auth.getSnapshot().status !== 'authenticated';
  let conflicted = false;
  let busy = false;
  let submitted = false;
  let revision = 0;
  let unsubscribe = () => {};
  const publish = (next: SaveState<C, T>) => { state = next; listeners.forEach((listener) => listener()); };
  const valid = () => state.status !== 'disposed' && generation === auth.getSnapshot().generation;
  const dispose = () => {
    revision++; body = null; key = null; unsubscribe();
    publish({ draft: null, status: 'disposed', current: null, result: null, error: null });
  };
  unsubscribe = auth.subscribe(() => {
    if (!valid()) { dispose(); return; }
    if (auth.getSnapshot().status !== 'authenticated') {
      needsRefresh = true; revision++;
      publish({ ...state, status: 'login', current: null, result: null });
    } else if (needsRefresh) publish({ ...state, status: 'refresh-required' });
  });
  const setFailure = (error: unknown) => {
    const safe = error instanceof ApiError ? error : new ApiError(503);
    if (safe.status === 409) { conflicted = true; needsRefresh = true; }
    if (safe.status === 401 || safe.status === 403) needsRefresh = true;
    publish({ ...state, result: null, error: safe, current: [401, 403, 409].includes(safe.status) ? null : state.current,
      status: safe.status === 401 ? 'login' : safe.status === 403 ? 'forbidden' : safe.status === 409 ? 'conflict' : safe.status === 503 ? 'unavailable' : 'error' });
    return safe;
  };
  const controller = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    save: async () => {
      if (!valid() || busy || state.status === 'saved' || state.status === 'forbidden') return;
      if (auth.getSnapshot().status !== 'authenticated') { needsRefresh = true; publish({ ...state, status: 'login' }); return; }
      if (conflicted) return;
      if (needsRefresh) { publish({ ...state, status: 'refresh-required' }); return; }
      const attempt = revision;
      busy = true; submitted = true; publish({ ...state, status: 'saving', error: null, result: null });
      try {
        const result = await api.command<T>(body!, key!);
        if (valid() && attempt === revision) publish({ ...state, status: 'saved', result });
      } catch (error) { if (valid() && (attempt === revision || error instanceof ApiError && error.status === 401)) setFailure(error); }
      finally { busy = false; }
    },
    refresh: async (): Promise<RefreshResult> => {
      if (!valid() || busy) return { status: 'blocked' };
      if (auth.getSnapshot().status !== 'authenticated') { publish({ ...state, status: 'login' }); return { status: 'blocked' }; }
      const attempt = revision; busy = true; needsRefresh = true;
      publish({ ...state, current: null, status: 'refresh-required', error: null });
      try {
        const current = await readCurrent();
        if (valid() && attempt === revision) {
          needsRefresh = false;
          const snapshot = Object.freeze({ versions: Object.freeze({ ...current.versions }), fields: Object.freeze({ ...current.fields }) });
          publish({ ...state, current: snapshot, status: conflicted ? 'conflict' : 'editing', error: null });
          return { status: 'ready', current: snapshot };
        }
      } catch (error) { if (valid() && attempt === revision) return { status: 'error', error: setFailure(error) }; }
      finally { busy = false; }
      return { status: 'blocked' };
    },
    reapply: (command: C) => {
      if (!valid() || busy || needsRefresh || !state.current || state.status === 'forbidden' || auth.getSnapshot().status !== 'authenticated') throw new ApiError(409);
      const next = canonicalCommand(command);
      assertCurrentVersions(JSON.parse(next), state.current.versions);
      const nextKey = next !== body ? crypto.randomUUID() : key!;
      assertEnvelopeBudget(next, nextKey);
      if (next !== body) submitted = false;
      body = next; key = nextKey; conflicted = false; revision++;
      publish({ ...state, draft: JSON.parse(next) as C, status: 'editing', result: null, error: null });
    },
    edit: (command: C) => {
      if (!valid() || busy) throw new ApiError(409);
      const next = canonicalCommand(command);
      if (next === body) return;
      // After a submission, changed input requires an explicit current-version read
      // and reapply. Preserve the submitted intention for uncertain-result recovery.
      if (submitted || state.status !== 'editing' || needsRefresh || conflicted) throw new ApiError(409);
      if (state.current) assertCurrentVersions(JSON.parse(next), state.current.versions);
      const nextKey = crypto.randomUUID();
      assertEnvelopeBudget(next, nextKey);
      body = next; key = nextKey; revision++;
      publish({ ...state, draft: JSON.parse(next) as C, result: null, error: null });
    },
    dispose,
  };
  return controller;
}

/** Create the controller once outside the form; mount it above the login boundary. */
export function useSaveIntent<C extends Command, T>(intent: ReturnType<typeof createSaveIntent<C, T>>) {
  return useSyncExternalStore(intent.subscribe, intent.getSnapshot, intent.getSnapshot);
}

function assertCurrentVersions(value: unknown, versions: CurrentVersion['versions']): void {
  if (!value || typeof value !== 'object') return;
  const object = value as Record<string, unknown>;
  if ('expectedVersion' in object && (typeof object.id !== 'string' || object.expectedVersion !== versions[object.id])) throw new ApiError(409);
  Object.values(object).forEach((child) => assertCurrentVersions(child, versions));
}

/** Same sorted-object/ordered-array JSON and parsed command normalization as server. */
function canonicalCommand(command: Command): string {
  canonicalJson(command); // Reject getters, undefined, sparse arrays and non-JSON before schema access.
  const parsed = commandSchema.safeParse(command);
  if (!parsed.success) throw new ApiError(400);
  return canonicalJson(parsed.data);
}

/** The server checks this envelope before reserving a mutation key. Wire format stays unchanged. */
function assertEnvelopeBudget(body: string, key: string): void {
  const envelope = '{"command":' + body + ',"idempotencyKey":' + JSON.stringify(key) + '}';
  if (new TextEncoder().encode(envelope).byteLength > MAX_COMMAND_BYTES) throw new ApiError(413);
}

function canonicalJson(value: unknown): string {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 50_000 || depth > 32) throw new ApiError(413);
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || ancestors.has(item)) throw new ApiError(400);
    const array = Array.isArray(item);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new ApiError(400);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) throw new ApiError(400);
    ancestors.add(item);
    let result: string;
    if (array) {
      if (Object.keys(descriptors).length !== item.length + 1 || item.length > 50_000) throw new ApiError(400);
      result = '[' + Array.from({ length: item.length }, (_, index) => {
        if (!descriptors[String(index)]) throw new ApiError(400);
        return visit(descriptors[String(index)]!.value, depth + 1);
      }).join(',') + ']';
    } else {
      result = '{' + Object.keys(descriptors).sort().map((key) => {
        if (!descriptors[key]!.enumerable) throw new ApiError(400);
        return JSON.stringify(key) + ':' + visit(descriptors[key]!.value, depth + 1);
      }).join(',') + '}';
    }
    ancestors.delete(item);
    if (new TextEncoder().encode(result).byteLength > MAX_COMMAND_BYTES) throw new ApiError(413);
    return result;
  };
  return visit(value, 0);
}
