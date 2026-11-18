import type { AuthController, AuthState } from '../../lib/auth';
import { useAuth } from '../../lib/auth';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import '../../components/session.css';

export function LoginPage({ auth }: { auth: AuthController }) {
  const session = useAuth(auth);
  return <LoginForm key={`${session.generation}:${session.status === 'recovery' ? 'recovery' : 'login'}`} auth={auth} session={session} />;
}

function LoginForm({ auth, session }: { auth: AuthController; session: AuthState }) {
  const [mode, setMode] = useState<'login' | 'request'>('login');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const operation = useRef(0);
  useEffect(() => () => { operation.current++; }, []);
  const recovery = session.status === 'recovery';
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const attempt = ++operation.current; const generation = session.generation;
    setBusy(true); setError(null); setMessage(null);
    try {
      if (recovery) await auth.updatePassword(password);
      else if (mode === 'request') await auth.requestRecovery(email);
      else await auth.login(email, password);
      if (operation.current === attempt && auth.getSnapshot().generation === generation) {
        setMessage(recovery ? 'Senha alterada.' : mode === 'request' ? 'Se o endereço estiver cadastrado, você receberá um link de recuperação.' : 'Acesso confirmado.');
      }
    } catch {
      if (operation.current === attempt && auth.getSnapshot().generation === generation) setError(recovery ? 'Não foi possível alterar a senha. Tente novamente.' : mode === 'request' ? 'Não foi possível solicitar a recuperação. Tente novamente.' : 'Não foi possível entrar. Confira suas credenciais e tente novamente.');
    } finally {
      if (operation.current === attempt) { setPassword(''); setBusy(false); }
    }
  };
  return <section className="session-ui session-login" aria-label="Acesso privado">
    <h1>{recovery ? 'Definir nova senha' : mode === 'request' ? 'Recuperar acesso' : 'Entrar'}</h1>
    <p>{recovery ? 'Escolha uma nova senha para sua conta.' : 'Acesse seu espaço privado de carreira.'}</p>
    <form onSubmit={(event) => { void submit(event); }}>
      {!recovery && <label>E-mail<input type="email" autoComplete="username" value={email} required disabled={busy} onChange={(event) => setEmail(event.target.value)} /></label>}
      {(recovery || mode === 'login') && <label>{recovery ? 'Nova senha' : 'Senha'}<input type="password" autoComplete={recovery ? 'new-password' : 'current-password'} value={password} required minLength={recovery ? 8 : undefined} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>}
      <button type="submit" disabled={busy}>{busy ? 'Aguarde…' : recovery ? 'Alterar senha' : mode === 'request' ? 'Enviar link de recuperação' : 'Entrar'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {!recovery && <button type="button" disabled={busy} onClick={() => { setMode(mode === 'login' ? 'request' : 'login'); setPassword(''); setError(null); setMessage(null); }}>{mode === 'login' ? 'Esqueci minha senha' : 'Voltar para entrar'}</button>}
  </section>;
}
