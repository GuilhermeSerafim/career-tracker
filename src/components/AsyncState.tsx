import type { ReactNode } from 'react';
import type { ApiError } from '../lib/api';
import './session.css';

export type AsyncValue<T> = { status: 'loading' } | { status: 'empty' } | { status: 'error'; error?: ApiError } | { status: 'ready'; data: T };
export function AsyncState<T>(props: { state: AsyncValue<T>; children: (data: T) => ReactNode; onRetry: () => void }) {
  const { state, children, onRetry } = props;
  if (state.status === 'loading') return <p role="status">Carregando dados…</p>;
  if (state.status === 'empty') return <p role="status">Nenhum registro encontrado.</p>;
  if (state.status === 'error') return <section className="session-ui session-async" aria-label="Falha ao carregar">
    <p role="alert">{state.error?.message ?? 'Não foi possível carregar os dados. Tente novamente.'}</p>
    {state.error?.requestId && <p>Referência: {state.error.requestId}</p>}
    <button type="button" onClick={onRetry}>Tentar novamente</button>
  </section>;
  return <>{children(state.data)}</>;
}
