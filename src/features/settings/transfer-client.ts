import type { AuthController } from '../../lib/auth';
import { ApiError } from '../../lib/api';

export const TRANSFER_LIMIT = 4_000_000;
export type ImportUnit = { unit: 'prepare' | 'application' | 'review' | 'complete'; data: Record<string, unknown> };
export function createTransferClient(auth: AuthController, transport: typeof fetch = fetch) {
  let period = 0; let disposed = false; let latestExport = 0;
  let importBusy = false;
  let state = { pendingImport: null as { unit: ImportUnit; key: string } | null, importStatus: 'idle' as 'idle' | 'saving' | 'uncertain' | 'saved', receiptId: 0, receivedAt: null as string | null, confirmedAt: null as string | null, format: null as 'csv' | 'json' | null, status: 'idle' as 'idle' | 'receiving' | 'received' | 'confirmed' | 'error' };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); };
  let generation = auth.getSnapshot().generation;
  const disconnect = auth.subscribe(() => {
    const next = auth.getSnapshot();
    if (next.generation !== generation) publish({ pendingImport: null, importStatus: 'idle' });
    else if (next.status !== 'authenticated' && state.pendingImport) publish({ importStatus: 'uncertain' });
    if (next.generation !== generation || next.status !== 'authenticated') { period++; latestExport++; publish({ receiptId: 0, receivedAt: null, confirmedAt: null, format: null, status: 'idle' }); }
    generation = next.generation;
  });
  const request = async (path: string, body?: unknown, key?: string) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && new TextEncoder().encode(serialized).byteLength > TRANSFER_LIMIT) throw new ApiError(413);
    const identity = auth.getSnapshot(); const epoch = period;
    if (disposed || identity.status !== 'authenticated' || !identity.session) throw new ApiError(401);
    const current = () => !disposed && period === epoch && auth.getSnapshot().generation === identity.generation && auth.getSnapshot().ownerId === identity.ownerId && auth.getSnapshot().status === 'authenticated';
    let response: Response;
    try { response = await transport(path, { method: serialized === undefined ? 'GET' : 'POST', body: serialized, cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${identity.session.access_token}`, ...(serialized === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) } }); }
    catch { throw new ApiError(current() ? 503 : 0); }
    if (!current()) throw new ApiError(0);
    if (!response.ok) {
      if (response.status === 401 && auth.getSnapshot().session?.access_token === identity.session.access_token) auth.expire();
      throw new ApiError(response.status);
    }
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try {
      if (!reader) throw new ApiError(503);
      while (true) { const next = await reader.read(); if (!current()) throw new ApiError(0); if (next.done) break; length += next.value.byteLength; if (length > TRANSFER_LIMIT) throw new ApiError(413); chunks.push(next.value); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (!current()) throw new ApiError(0);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) { await reader?.cancel().catch(() => {}); throw error instanceof ApiError ? error : new ApiError(current() ? 503 : 0); }
    finally { reader?.releaseLock(); }
  };
  const json = async (path: string, body: unknown, key?: string): Promise<Record<string, unknown>> => {
    const epoch = period; const text = await request(path, body, key);
    if (disposed || epoch !== period || auth.getSnapshot().status !== 'authenticated') throw new ApiError(0);
    try { return JSON.parse(text); } catch { throw new ApiError(503); }
  };
  const retryImport = async () => {
    if (!state.pendingImport || importBusy || disposed || auth.getSnapshot().status !== 'authenticated') throw new ApiError(409);
    const pending = state.pendingImport; const ownerGeneration = generation; const epoch = period;
    importBusy = true; publish({ importStatus: 'saving' });
    try {
      const result = await json('/api/v1/imports/apply', pending.unit, pending.key);
      if (disposed || generation !== ownerGeneration || epoch !== period || auth.getSnapshot().status !== 'authenticated') throw new ApiError(0);
      publish({ pendingImport: null, importStatus: 'saved' }); return result;
    } catch (error) { if (!disposed && generation === ownerGeneration) publish({ importStatus: 'uncertain' }); throw error; }
    finally { importBusy = false; }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    export: async (format: 'csv' | 'json') => {
      if (!['csv', 'json'].includes(format)) throw new ApiError(400);
      if (disposed || auth.getSnapshot().status !== 'authenticated') throw new ApiError(401);
      const epoch = period; const receiptId = ++latestExport;
      const current = () => !disposed && epoch === period && receiptId === latestExport && auth.getSnapshot().status === 'authenticated';
      publish({ receiptId, receivedAt: null, format, status: 'receiving' });
      try { const text = await request(`/api/v1/exports?format=${format}`); if (!current()) throw new ApiError(0); if (format === 'json') { try { JSON.parse(text); } catch { throw new ApiError(503); } } publish({ receivedAt: new Date().toISOString(), status: 'received' }); return { text, receiptId }; }
      catch (error) { if (current()) publish({ status: 'error', receivedAt: null }); throw error; }
    },
    confirmSaved: (receiptId: number) => { if (!disposed && receiptId === latestExport && auth.getSnapshot().status === 'authenticated' && state.status === 'received') publish({ confirmedAt: new Date().toISOString(), status: 'confirmed' }); },
    downloadFailed: (receiptId: number) => { if (!disposed && receiptId === latestExport && auth.getSnapshot().status === 'authenticated') publish({ status: 'error', receivedAt: null }); },
    review: (id: string) => { if (!/^[0-9a-f-]{36}$/i.test(id)) return Promise.reject(new ApiError(400)); return request(`/api/v1/reviews/${id}?format=markdown`); },
    previewCsv: (bytesBase64: string) => json('/api/v1/imports/preview', { bytesBase64 }),
    previewRun: (runId: string) => json('/api/v1/imports/preview', { runId }),
    previewRestore: (snapshot: unknown) => json('/api/v1/restores/preview', { snapshot }),
    importUnit: async (unit: ImportUnit, key: string) => {
      if (state.pendingImport || importBusy || disposed || auth.getSnapshot().status !== 'authenticated') throw new ApiError(409);
      const serialized = JSON.stringify(unit);
      if (new TextEncoder().encode(serialized).byteLength > TRANSFER_LIMIT) throw new ApiError(413);
      publish({ pendingImport: { unit: JSON.parse(serialized) as ImportUnit, key } }); return retryImport();
    },
    retryImport,
    dispose: () => { disposed = true; period++; latestExport++; disconnect(); publish({ pendingImport: null, importStatus: 'idle', receiptId: 0, receivedAt: null, confirmedAt: null, format: null, status: 'idle' }); listeners.clear(); },
  };
}
export function downloadText(text: string, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  try { const link = document.createElement('a'); link.href = url; link.download = fileName; document.body.appendChild(link); link.click(); link.remove(); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
