import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';

const destinations = [
  { path: '/', label: 'Hoje', symbol: 'M4 10 12 3l8 7v10h-6v-6h-4v6H4Z' },
  { path: '/vagas', label: 'Vagas', symbol: 'M8 7V4h8v3M3 8h18v12H3ZM3 12h18M10 12v3h4v-3' },
  { path: '/analises', label: 'Análises', symbol: 'M4 3v18h17M8 16v-5m5 5V7m5 9V4' },
  { path: '/revisoes', label: 'Revisões', symbol: 'M5 3h14v18H5ZM8 8h8M8 12h8m-8 4h5' },
];

export function Shell({ children, onLogout }: { children: ReactNode; onLogout(): Promise<void> }) {
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  const current = destinations.find(({ path }) => path === '/' ? location.pathname === '/' : location.pathname.startsWith(path))?.label ?? (location.pathname === '/configuracoes' ? 'Configurações' : 'Carreira');
  useEffect(() => {
    const heading = main.current?.querySelector('h1');
    heading?.focus();
    document.title = `${current} · Carreira`;
  }, [location.pathname, current]);
  return <div className="app-shell">
    <a className="skip-link" href="#conteudo">Pular para o conteúdo</a>
    <aside className="sidebar">
      <div className="brand">Carreira<span aria-hidden="true">↗</span><small>UM PASSO DE CADA VEZ</small></div>
      <nav className="primary-nav" aria-label="Navegação principal">
        {destinations.map(({ path, label, symbol }, index) => <NavLink key={path} to={path} end={path === '/'}>
          <span className="nav-index" aria-hidden="true">0{index + 1}</span><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={symbol} /></svg><span>{label}</span>
        </NavLink>)}
      </nav>
      <div className="rail-foot"><span className="privacy-mark" aria-hidden="true">●</span> Espaço pessoal<small>Acesso privado</small></div>
    </aside>
    <div className="workspace"><header className="workspace-header"><span className="header-location"><span className="mobile-brand">Carreira<span aria-hidden="true">↗</span></span><span className="desktop-location">SEU ESPAÇO <span aria-hidden="true">/</span> {current.toLocaleUpperCase('pt-BR')}</span></span><AccountMenu onLogout={onLogout} /></header>
      <main id="conteudo" ref={main} tabIndex={-1}>{children}</main>
    </div>
  </div>;
}

function AccountMenu({ onLogout }: { onLogout(): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null); const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return <div className="account-menu" ref={menu} onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } }}>
    <button type="button" ref={button} className="account-trigger" aria-expanded={open} aria-controls="account-options" onClick={() => setOpen(!open)}><span className="account-avatar" aria-hidden="true">C</span>Conta<span aria-hidden="true">⌄</span></button>
    {open && <div id="account-options" className="account-options" role="group" aria-label="Opções da conta">
      <p>Seu espaço privado</p><Link to="/configuracoes" onClick={() => setOpen(false)}>Configurações</Link><button type="button" onClick={() => { setOpen(false); void onLogout(); }}>Sair da conta</button>
    </div>}
  </div>;
}
