import type { AppRuntime } from './runtime';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { lazy, Suspense, useState } from 'react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { LoginPage } from '../features/auth/LoginPage';
import { Shell } from './Shell';
import { TodayPage } from '../features/today/TodayPage';
import { ApplicationForm } from '../features/applications/ApplicationForm';
import { ListPage } from '../features/applications/ListPage';
import { DetailPage } from '../features/applications/DetailPage';
import { ReviewsPage } from '../features/reviews/ReviewsPage';
import { SettingsPage } from '../features/settings/SettingsPage';

const AnalyticsPage = lazy(() => import('../features/analytics/AnalyticsPage'));

export function App({ runtime }: { runtime: AppRuntime | null }) {
  if (!runtime) return <AccessFrame><h1>Acesso indisponível</h1><p>A autenticação ainda não está configurada. Tente novamente mais tarde.</p></AccessFrame>;
  return <QueryClientProvider client={runtime.query}><SessionBoundary runtime={runtime} /></QueryClientProvider>;
}

function AccessFrame({ children }: { children: React.ReactNode }) {
  return <main className="access-frame"><div className="access-brand">Carreira<span aria-hidden="true">↗</span></div><div className="access-card">{children}</div><p className="access-foot">Seu espaço pessoal de carreira.</p></main>;
}

function SessionBoundary({ runtime }: { runtime: AppRuntime }) {
  const session = useAuth(runtime.auth);
  const location = useLocation();
  const [recovering, setRecovering] = useState(false);
  const [logoutError, setLogoutError] = useState<number | null>(null);
  if (session.status === 'recovery' && !recovering) setRecovering(true);
  const logout = async () => {
    setLogoutError(null);
    try { await runtime.auth.logout(); } catch { setLogoutError(runtime.auth.getSnapshot().generation); }
  };
  if (session.status === 'loading') return <AccessFrame><p role="status">Verificando acesso…</p></AccessFrame>;
  if (session.status === 'login' || session.status === 'recovery') return <AccessFrame><LoginPage auth={runtime.auth} />
    {logoutError === session.generation && <p role="alert">A sessão local foi encerrada. Não foi possível confirmar a saída no serviço.</p>}</AccessFrame>;
  if (recovering && location.pathname === '/recuperar-senha') return <Navigate to="/" replace />;
  if (location.pathname === '/recuperar-senha') return <AccessFrame><h1>Recuperar acesso</h1><p>Abra o link de recuperação recebido por e-mail para definir uma nova senha.</p><a href="/">Voltar para Hoje</a></AccessFrame>;
  const accessPeriod = runtime.getAccessPeriod();
  return <OwnerBoundary key={`${session.generation}:${session.ownerId}:${accessPeriod}`} runtime={runtime} accessPeriod={accessPeriod} onLogout={logout} />;
}

function OwnerBoundary({ runtime, accessPeriod, onLogout }: { runtime: AppRuntime; accessPeriod: number; onLogout(): Promise<void> }) {
  const access = useQuery({ queryKey: ['owner-access', runtime.auth.getSnapshot().generation, accessPeriod],
    queryFn: async () => {
      const result = await runtime.api.read<{ status: string }>('/api/v1/health');
      if (result?.status !== 'ok') throw new ApiError(503);
      return true;
    }, refetchOnWindowFocus: false });
  if (access.isPending) return <AccessFrame><p role="status">Verificando acesso…</p></AccessFrame>;
  if (access.isError) return <AccessFrame>
    <h1>{access.error instanceof ApiError && access.error.status === 403 ? 'Acesso não autorizado' : 'Espaço indisponível'}</h1>
    <p role="alert">{access.error instanceof ApiError && access.error.status === 403 ? 'Esta conta não tem acesso a este espaço privado.' : 'Não foi possível acessar seu espaço. Tente novamente.'}</p>
    <button type="button" onClick={() => { void access.refetch(); }}>Tentar novamente</button><button type="button" onClick={() => { void onLogout(); }}>Sair da conta</button>
  </AccessFrame>;
  return <Shell onLogout={onLogout}><Routes>
    <Route path="/" element={<TodayPage runtime={runtime} />} />
    <Route path="/vagas/nova" element={<ApplicationForm runtime={runtime} />} />
    <Route path="/vagas/:id" element={<DetailPage runtime={runtime} />} />
    <Route path="/vagas/:id/editar" element={<ApplicationForm runtime={runtime} />} />
    <Route path="/vagas" element={<ListPage runtime={runtime} />} />
    <Route path="/analises" element={<Suspense fallback={<p role="status">Carregando análises…</p>}><AnalyticsPage runtime={runtime} /></Suspense>} />
    <Route path="/revisoes" element={<ReviewsPage runtime={runtime} />} />
    <Route path="/revisoes/:id" element={<ReviewsPage runtime={runtime} />} />
    <Route path="/configuracoes" element={<SettingsPage runtime={runtime} />} />
    <Route path="*" element={<><p className="eyebrow">Carreira</p><h1 tabIndex={-1}>Página não encontrada</h1><a className="text-action" href="/">Voltar para Hoje ↗</a></>} />
  </Routes></Shell>;
}
