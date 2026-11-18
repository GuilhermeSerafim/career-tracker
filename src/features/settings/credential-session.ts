import { commandSchema, type AgentScope } from '../../../shared/commands';
import type { AppRuntime } from '../../app/runtime';
import { ApiError } from '../../lib/api';
import { credentialResultSchema } from '../../../shared/agent-credentials';

interface State { status: 'idle' | 'saving' | 'uncertain' | 'shown' | 'forgotten'; token: string | null; error: string | null }
/** Dedicated credential memory. Never registered as a retained business draft. */
export function createCredentialSession(runtime: AppRuntime) {
  let state: State = { status: 'idle', token: null, error: null };
  let pending: { body: string; key: string; token: string; id: string } | null = null;
  let epoch = 0; let disposed = false;
  const identity = runtime.auth.getSnapshot(); const period = runtime.getAccessPeriod();
  const listeners = new Set<() => void>();
  const emit = (next: State) => { state = next; listeners.forEach(listener => listener()); };
  const current = () => !disposed && runtime.auth.getSnapshot().status === 'authenticated' && runtime.auth.getSnapshot().generation === identity.generation && runtime.auth.getSnapshot().ownerId === identity.ownerId && runtime.getAccessPeriod() === period;
  const clear = () => { epoch++; pending = null; emit({ status: 'forgotten', token: null, error: null }); };
  let unsubscribe: (() => void) | undefined;
  async function submit() {
    if (!current() || !pending || state.status === 'saving') return;
    const attempt = epoch; const body = pending.body; const key = pending.key; const id = pending.id;
    emit({ status: 'saving', token: null, error: null });
    try {
      const result = credentialResultSchema.parse(await runtime.api.command(body, key));
      if (!current() || epoch !== attempt || !pending) return;
      if (!result.credential || result.credential.id !== id || result.credential.revokedAt !== null) throw new ApiError(503);
      const token = pending.token; pending = null;
      emit({ status: 'shown', token, error: null });
    } catch (error) {
      if (!current() || epoch !== attempt) return;
      if (error instanceof ApiError && [401,403,409].includes(error.status)) { clear(); emit({ status: 'forgotten', token: null, error: 'Criação interrompida. Releia a lista; revogue a credencial se ela existir e emita outra.' }); }
      else if (error instanceof ApiError && error.status >= 400 && error.status < 500) { clear(); emit({ status: 'idle', token: null, error: 'Dados recusados. Confira o nome, as permissões e uma expiração futura.' }); }
      else emit({ status: 'uncertain', token: null, error: 'Sem confirmação. Repita a mesma criação enquanto esta tela permanece aberta.' });
    }
  }
  return {
    // Setup belongs to the effect, so StrictMode's discarded render owns no listener.
    connect: () => { disposed = false; unsubscribe ??= runtime.auth.subscribe(() => { if (!current()) clear(); }); },
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async create(label: string, scopes: AgentScope[], expiresAt: string | null) {
      if (!current() || pending || ['saving','shown'].includes(state.status)) return;
      const attempt = ++epoch; const id = crypto.randomUUID(); const bytes = crypto.getRandomValues(new Uint8Array(32));
      const secret = btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '');
      emit({ status: 'saving', token: null, error: null });
      try {
        const digest = await crypto.subtle.digest('SHA-256', bytes); bytes.fill(0);
        if (!current() || attempt !== epoch) return;
        const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
        const command = commandSchema.parse({ operation: 'create_agent_credential', clientId: id, label, prefix: id.slice(0,8), tokenHash, scopes, expiresAt });
        pending = { body: JSON.stringify(command), key: crypto.randomUUID(), token: `ct_agent_${id}.${secret}`, id };
        emit({ status: 'idle', token: null, error: null }); await submit();
      } catch { bytes.fill(0); if (current() && attempt === epoch) emit({ status: 'idle', token: null, error: 'Confira o nome, as permissões e a expiração.' }); }
    },
    retry: submit,
    forget: clear,
    dispose: () => { disposed = true; clear(); unsubscribe?.(); unsubscribe = undefined; },
  };
}
