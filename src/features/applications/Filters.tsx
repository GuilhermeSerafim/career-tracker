import { useState } from 'react';
import type { ApplicationFilters } from '../../../shared/queries';
import { applicationFiltersSchema } from '../../../shared/queries';
import { split, statuses } from './application-data';
export interface FilterState { view: string; search: string; filters: ApplicationFilters }
const names = { company: 'empresa', title: 'cargo', stack: 'stack', seniority: 'senioridade', modality: 'modalidade', channel: 'canal', platform: 'plataforma', batch: 'lote (ID)' } as const;
export function Filters({ value, onApply }: { value: FilterState; onApply(value: FilterState): void }) {
  const [draft, setDraft] = useState(value); const [error, setError] = useState('');
  const [text, setText] = useState(() => Object.fromEntries(Object.keys(names).map((key) => [key, value.filters[key as keyof typeof names]?.join(', ') ?? ''])));
  return <form className="application-filters" onSubmit={(e) => { e.preventDefault(); const filters = { ...draft.filters }; for (const key of Object.keys(names) as (keyof typeof names)[]) { const values = split(text[key] ?? ''); if (values.length) filters[key] = values; else delete filters[key]; } const parsed = applicationFiltersSchema.safeParse(filters); if (!parsed.success) { setError('Confira os filtros; lote exige um ID válido.'); return; } setError(''); onApply({ ...draft, filters: parsed.data }); }}>
    <div className="application-grid"><label>Visualização<select aria-label="Visualização" value={draft.view} onChange={(e) => setDraft({ ...draft, view: e.target.value })}><option value="confirmed">Candidaturas confirmadas</option><option value="saved">Oportunidades salvas</option><option value="unknown">Envio desconhecido</option><option value="all">Todos os registros</option></select></label>
      <label>Buscar<input maxLength={200} value={draft.search} onChange={(e) => setDraft({ ...draft, search: e.target.value })} placeholder="Empresa, cargo, ID ou observações" /></label></div>
    <details><summary>Refinar filtros</summary><p>Valores exatos; separe alternativas por vírgulas. Stack aceita qualquer valor informado.</p><div className="application-grid">{Object.entries(names).map(([key, label]) => <label key={key}>Filtrar {label}<input value={text[key] ?? ''} onChange={(e) => setText({ ...text, [key]: e.target.value })} /></label>)}
      <label>Filtrar status<select aria-label="Filtrar status" value={draft.filters.status?.[0] ?? ''} onChange={(e) => { const next = { ...draft.filters }; if (e.target.value) next.status = [e.target.value as keyof typeof statuses]; else delete next.status; setDraft({ ...draft, filters: next }); }}><option value="">Qualquer status</option>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>Arquivadas<select aria-label="Arquivadas" value={draft.filters.archived ?? 'exclude'} onChange={(e) => setDraft({ ...draft, filters: { ...draft.filters, archived: e.target.value as ApplicationFilters['archived'] } })}><option value="exclude">Ocultar arquivadas</option><option value="include">Incluir arquivadas</option><option value="only">Somente arquivadas</option></select></label></div></details>
    {error && <p role="alert">{error}</p>}<button type="submit">Aplicar filtros</button>
  </form>;
}
