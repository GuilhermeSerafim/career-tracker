import type { AppRuntime } from '../../app/runtime';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AgentScope } from '../../../shared/commands';
import { ApiError } from '../../lib/api';
import { createCredentialSession } from './credential-session';
import { credentialPageSchema, type CredentialMetadata } from '../../../shared/agent-credentials';
import { useQuery } from '@tanstack/react-query';
const labels: Record<AgentScope, string> = { 'career:read': 'Consultar carreira', 'career:write': 'Registrar carreira', 'career:reviews': 'Fechar e revisar lotes', 'career:export': 'Exportar dados privados' };
export function AgentCredentials({ runtime }: { runtime: AppRuntime }) {
  const [session] = useState(() => createCredentialSession(runtime));
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [label, setLabel] = useState(''); const [scopes, setScopes] = useState<AgentScope[]>(['career:read']); const [expiry, setExpiry] = useState('');
  const [pageCursor, setPageCursor] = useState<string | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const query = useQuery({ queryKey: ['agent-credentials', pageCursor], queryFn: async () => credentialPageSchema.parse(await runtime.api.read('/api/v1/agent-credentials?limit=20' + (pageCursor ? '&cursor=' + encodeURIComponent(pageCursor) : ''))) }, runtime.query);
  const items = query.data?.items ?? []; const cursor = query.data?.nextCursor;
  const [revocation, setRevocation] = useState<{ body: string; key: string } | null>(null);
  useEffect(() => { session.connect(); return () => session.dispose(); }, [session]);
  const load = async (next: string | null = null) => { setError(''); if (next !== pageCursor) setPageCursor(next); else await query.refetch(); };
  const revoke = async (credential?: CredentialMetadata) => {
    const intention = credential ? { body: JSON.stringify({ operation: 'revoke_agent_credential', credential: { id: credential.id, expectedVersion: credential.version } }), key: crypto.randomUUID() } : revocation;
    if (!intention) return;
    setRevocation(intention); setBusy(true); setError('');
    try { await runtime.api.command(intention.body, intention.key); setRevocation(null); session.forget(); await load(); }
    catch (failure) { if (failure instanceof ApiError && [401,403,409].includes(failure.status)) { setRevocation(null); setError('Releia as credenciais antes de autorizar outra revogação.'); } else setError('Revogação sem confirmação. Repita a mesma revogação.'); }
    finally { setBusy(false); }
  };
  const locked = ['saving','uncertain','shown'].includes(state.status);
  return <section className="review-panel"><h2>Acesso do agente</h2><p>Credencial restrita e revogável. O segredo aparece uma vez após a confirmação. Guarde em canal privado; nunca em chat, documentos ou repositório.</p><p>Sair desta tela, expirar a sessão ou fechar a aba descarta o segredo, mas não revoga a credencial. A criação pode ter sido confirmada no servidor mesmo sem resposta. Se perder o segredo, releia a lista, identifique o nome e o ID, revogue explicitamente a credencial anterior e só então emita outra.</p>
    <form onSubmit={event => { event.preventDefault(); if (!event.currentTarget.reportValidity()) return; void session.create(label, scopes, expiry ? new Date(expiry).toISOString() : null); }}>
    <label>Nome da credencial<input value={label} maxLength={200} required disabled={locked} onChange={event => setLabel(event.target.value)} /></label>
    <fieldset disabled={locked}><legend>Permissões</legend>{Object.entries(labels).map(([scope, text]) => <label key={scope}><input type="checkbox" checked={scopes.includes(scope as AgentScope)} onChange={event => setScopes(event.target.checked ? [...scopes, scope as AgentScope] : scopes.filter(value => value !== scope))} />{text}</label>)}</fieldset>
    <label>Expira em (opcional)<input type="datetime-local" disabled={locked} value={expiry} onChange={event => setExpiry(event.target.value)} /></label>
    <button type="submit" disabled={locked || !label.trim() || !scopes.length}>Criar credencial</button></form>
    {state.status === 'saving' && <p role="status">Aguardando confirmação…</p>}{state.error && <p role="alert">{state.error}</p>}{state.status === 'uncertain' && <button onClick={() => { void session.retry(); }}>Repetir mesma criação</button>}
    {state.token && <div><p>Exibição única. Selecione o campo e use Ctrl+C para copiar para seu ambiente privado.</p><textarea aria-label="Credencial exibida uma vez" readOnly rows={3} autoComplete="off" spellCheck={false} value={state.token} onFocus={event => event.currentTarget.select()} style={{ width: '100%', overflowWrap: 'anywhere' }} /><button onClick={() => { session.forget(); void load(); }}>Guardei em local privado; ocultar</button></div>}
    <h3>Credenciais emitidas</h3><button disabled={busy || query.isFetching} onClick={() => { void load(); }}>Reler credenciais</button>{(error || query.isError) && <p role="alert">{error || 'Não foi possível reler as credenciais.'}</p>}{query.isPending ? <p role="status">Lendo credenciais…</p> : query.isSuccess && !items.length && <p>Nenhuma credencial nesta página.</p>}<ul>{items.map(item => <li key={item.id}><strong>{item.label}</strong> · {item.prefix} · versão {item.version}<p style={{ overflowWrap: 'anywhere' }}>ID: {item.id}</p><p>{item.scopes.map(scope => labels[scope]).join(', ')}. {item.revokedAt ? 'Revogada' : item.expiresAt ? `Expira em ${new Date(item.expiresAt).toLocaleString('pt-BR')}` : 'Sem expiração'}</p>{!item.revokedAt && <button disabled={busy || !!revocation} onClick={() => { void revoke(item); }}>Revogar {item.label}</button>}</li>)}</ul>{cursor && <button disabled={busy} onClick={() => { void load(cursor); }}>Próxima página de credenciais</button>}{revocation && <button disabled={busy} onClick={() => { void revoke(); }}>Repetir mesma revogação</button>}
  </section>;
}
