import { safeReference } from '../lib/links';
export interface SafeLinkProps { value: string; label?: string; isLocal?: boolean }
/** Use only in authenticated detail. Labels are text, never Markdown or HTML. */
export function SafeLink({ value, label, isLocal = false }: SafeLinkProps) {
  const reference = safeReference(value, isLocal);
  if (reference.kind === 'external') return <a className="safe-link" href={reference.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
    {label || 'Abrir referência externa'}<span className="sr-only"> (nova aba)</span><span aria-hidden="true"> ↗</span>
  </a>;
  return <span className="safe-reference"><span>{label || (reference.kind === 'local' ? 'Referência local' : 'Referência')}</span>
    {reference.kind === 'local' && <code>{reference.reference}</code>}
    <small>{reference.kind === 'local' ? 'Arquivo neste computador. Abra-o pelo seu gerenciador de arquivos.' : 'Referência indisponível.'}</small></span>;
}
