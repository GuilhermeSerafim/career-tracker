import './app/validation';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './app/App';
import { createAppRuntime } from './app/runtime';
import { createBrowserAuth } from './lib/auth';
import './styles/tokens.css';
import './styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('Elemento raiz não encontrado.');

// One runtime, constructed and connected synchronously outside StrictMode.
// No URL flag, global hook or production test-auth bypass.
let runtime = null;
try { runtime = createAppRuntime(createBrowserAuth()); } catch { /* Safe configuration state. */ }

createRoot(root).render(
  <StrictMode>
    <BrowserRouter><App runtime={runtime} /></BrowserRouter>
  </StrictMode>,
);
