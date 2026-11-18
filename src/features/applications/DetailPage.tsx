import { useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { AppRuntime } from '../../app/runtime';
import { SafeLink } from '../../components/SafeLink';
import { displayDate } from '../today/today-data';
import { eventKinds, eventStates, readContacts, readDetail, stages, statuses } from './application-data';
import type { Detail, DetailContact } from './application-data';
import { ActivityForm } from './ActivityForm';
import { ApplicationActions } from './ApplicationActions';
import './applications.css';

function pageDraft() {
  let state = { correctionId: '', contactId: '', contacts: [] as DetailContact[] };
  const listeners = new Set<() => void>();
  const patch = (next: Partial<typeof state>) => { state = { ...state, ...next }; listeners.forEach((fn) => fn()); };
  return { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, patch,
    useContact: (contact: DetailContact) => patch({ contacts: [...state.contacts.filter((c) => c.id !== contact.id), contact] }),
    dispose: () => { state = { correctionId: '', contactId: '', contacts: [] }; listeners.clear(); },
  };
}
const precisionLabels = { unknown: 'desconhecida', day: 'dia', month: 'mês', year: 'ano', instant: 'instante com fuso' };
const evidenceLabels = { relato_usuario: 'Relato do usuário', portal_observado: 'Portal observado', email: 'E-mail', arquivo_local: 'Arquivo local', texto_legado: 'Texto legado', outro: 'Outra origem' };
const date = (value: Parameters<typeof displayDate>[0]) => displayDate(value, 'America/Sao_Paulo');
export function DetailPage({ runtime }: { runtime: AppRuntime }) {
  const { id } = useParams();
  const query = useQuery({ queryKey: ['application-detail', id, runtime.auth.getSnapshot().generation, runtime.getAccessPeriod()], queryFn: () => readDetail(runtime, id!), refetchOnWindowFocus: false });
  return <><section className="page-intro"><p className="eyebrow">Uma oportunidade de cada vez</p><h1 tabIndex={-1}>Vagas</h1><p>Histórico e acompanhamento</p><Link to="/vagas">Voltar para a lista</Link></section>
    {query.isPending && <p role="status">Carregando histórico…</p>}
    {query.isError && <><p role="alert">Não foi possível atualizar o histórico. Os rascunhos foram mantidos.</p><button onClick={() => { void query.refetch(); }}>Tentar novamente</button></>}
    {query.data && <DetailView key={id} runtime={runtime} detail={query.data} refresh={() => query.refetch().then((result) => !result.isError)} />}
  </>;
}
function DetailView({ runtime, detail, refresh }: { runtime: AppRuntime; detail: Detail; refresh(): Promise<boolean> }) {
  const [draft] = useState(() => runtime.retainDraft(`application-detail-page:${detail.application.id}`, pageDraft));
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const [refreshing, setRefreshing] = useState(false); const [actionsRevision, setActionsRevision] = useState(0);
  const a = detail.application; const o = a.opportunity;
  const catalog = useQuery({ queryKey: ['contact-catalog', runtime.auth.getSnapshot().generation, runtime.getAccessPeriod()], queryFn: () => readContacts(runtime), refetchOnWindowFocus: false });
  const contactsById = new Map<string, DetailContact>();
  for (const contact of [...state.contacts, ...detail.contacts, ...(catalog.data ?? [])]) {
    if ((contactsById.get(contact.id)?.version ?? 0) <= contact.version) contactsById.set(contact.id, contact);
  }
  const contacts = [...contactsById.values()];
  const useContact = (contact: DetailContact) => { draft.useContact(contact); void catalog.refetch(); };
  const correction = detail.events.find((event) => event.id === state.correctionId);
  const editingContact = contacts.find((contact) => contact.id === state.contactId);
  const reload = async () => { if (refreshing) return; setRefreshing(true); try { return await refresh(); } finally { setRefreshing(false); } };
  const reloadAction = async () => { if (await reload()) { runtime.abandonDraft(`application-actions:${a.id}`); setActionsRevision((n) => n + 1); } };
  const readOnly = a.canonicalApplicationId !== null;
  return <div className="application-detail">
    <header className="detail-heading"><div><p className="eyebrow">{a.displayId} · {a.track || 'Trilha não informada'}</p><h2>{o.title || 'Cargo não informado'}</h2><p>{o.company || 'Empresa não informada'}</p></div><div className="detail-controls">{!readOnly && <Link className="application-primary" to={`/vagas/${a.id}/editar`}>Editar registro</Link>}<button disabled={refreshing} onClick={() => { void reload(); }}>{refreshing ? 'Atualizando histórico…' : 'Atualizar histórico'}</button></div></header>
    <section className="detail-summary" aria-label="Envio e etapa"><div><span className="eyebrow">Envio</span><h3>{statuses[a.submissionStatus]}</h3><p>{date(a.submittedDate)}</p></div><div><span className="eyebrow">Etapa atual informada</span><h3>{stages[a.stage]}</h3><p>Etapa e atividade não confirmam um novo envio.</p></div></section>
    {a.cycleRelation === 'before_reset' && <p className="application-notice">Resultado de processo anterior. Acompanhamento não representa uma nova candidatura no ciclo.</p>}
    {a.archivedAt && <p className="application-notice">Registro arquivado. Histórico, contagens e ações pendentes são preservados.</p>}
    {readOnly && <p className="application-notice">Este registro tem um destino canônico. <Link to={`/vagas/${a.canonicalApplicationId}`}>Abrir registro canônico para acompanhar ou corrigir</Link>.</p>}
    <div className="detail-columns"><section className="detail-panel" aria-label="Referências do registro"><h3>Referências do registro</h3><p>{a.notes || 'Sem observações.'}</p><p>Ocorrência: {a.applicationInstance === 'initial' ? 'Inicial' : a.applicationInstance}</p><p>Canal: {a.discoveryChannel || 'Não informado'} · Plataforma de envio: {a.submissionPlatform || 'Não informada'}</p><h4>Links originais e alternativos</h4>{detail.links.length ? <ul>{detail.links.map((link, i) => <li key={i}><SafeLink value={link.originalUrl} isLocal={link.isLocal} label={`${link.kind} · referência ${i + 1}`} /></li>)}</ul> : <p>Nenhum link informado.</p>}<h4>Currículo efetivamente informado como enviado</h4>{detail.resumeRefs.length ? <ul>{detail.resumeRefs.map((resume) => <li key={resume.id}>{resume.label || 'Currículo sem nome'}{resume.language && ` · ${resume.language}`}{resume.stack.length > 0 && ` · ${resume.stack.join(', ')}`}{resume.localRef && <SafeLink value={resume.localRef} isLocal />}</li>)}</ul> : <p>Currículo não informado.</p>}</section>
    <section className="detail-panel" aria-label="Próximas ações do processo"><h3>Próximas ações</h3><p>Prazos não geram notificação nem sincronização com calendário.</p>{!detail.tasks.length && <p>Nenhuma ação registrada.</p>}<ul className="detail-task-list">{detail.tasks.map((task) => <li key={task.id}><strong>{task.title}</strong><p>{task.status === 'pending' ? 'Pendente' : task.status === 'completed' ? 'Concluída' : 'Cancelada'} · Prazo: {date(task.dueDate)}</p>{task.contactId && <p>Contato: {contacts.find((c) => c.id === task.contactId)?.name || 'Contato sem nome informado'}</p>}{task.status === 'completed' && <p>Conclusão: {date(task.completedDate)}</p>}{task.status === 'pending' && <details><summary>Concluir ação</summary><ActivityForm runtime={runtime} detail={detail} mode="complete" canonicalId={a.canonicalApplicationId} task={task} contact={contacts.find((c) => c.id === task.contactId)} onSaved={() => { void reload(); }} /></details>}</li>)}</ul></section></div>
    <section className="detail-panel" aria-label="Histórico do processo"><div className="detail-heading"><h3>Histórico do processo</h3><span className="status-chip">Ocorrência ≠ registro</span></div><p>Notas são resultados informados, com sua origem e unidade. Convite, conclusão ou avaliação reaproveitada não indicam aprovação.</p>{!detail.events.length && <p>Nenhuma atividade estruturada registrada. Isso não prova ausência de acontecimentos.</p>}
      <ol className="process-timeline">{detail.events.map((event) => { const proof = detail.evidence.find((item) => item.id === event.evidenceId); return <li key={event.id} className={event.superseded ? 'timeline-original' : ''}><article><div className="detail-heading"><h4>{eventKinds[event.kind]} · {eventStates[event.state]}</h4>{event.superseded && <span className="status-chip">Interpretação original substituída</span>}{event.supersedesEventId && <span className="status-chip">Interpretação corrigida</span>}</div><p>Aconteceu em {date(event.occurredDate)}</p><p>Precisão: {precisionLabels[event.occurredDate.precision]}{event.occurredDate.precision !== 'unknown' && ` · Certeza: ${event.occurredDate.certainty === 'approximate' ? 'aproximada' : 'exata'}`}</p><p className="timeline-recorded">Registrado em {new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(event.recordedAt))}</p>{event.supersedesEventId && <p>Substitui o evento original: {event.supersedesEventId}</p>}{event.resultText && <p className="preserved-text">{event.resultText}</p>}{event.scoreValue !== null && <p className="reported-score">Nota informada: <strong>{event.scoreValue} {event.scoreUnit || '(unidade não informada)'}</strong></p>}{event.sourceText && <p className="preserved-text">Origem: {event.sourceText}</p>}{proof && <details open><summary>Evidência e texto original</summary><p>Tipo: {evidenceLabels[proof.kind]} · Origem: {proof.source || 'Não informada'}</p>{proof.occurredDate && <p>Data da evidência: {date(proof.occurredDate)}</p>}{proof.originalText && <p className="preserved-text">{proof.originalText}</p>}{proof.privateRef && <SafeLink value={proof.privateRef} label="Referência privada da evidência" />}{proof.localRef && <SafeLink value={proof.localRef} isLocal />}</details>}{!readOnly && !event.superseded && !['envio_confirmado', 'correcao'].includes(event.kind) && <button onClick={() => draft.patch({ correctionId: event.id })}>Corrigir interpretação deste evento</button>}</article></li>; })}</ol>
    </section>
    {correction && <ActivityForm key={correction.id} runtime={runtime} detail={detail} mode="correction" canonicalId={a.canonicalApplicationId} event={correction} onSaved={() => { void reload(); }} />}
    {<><ActivityForm runtime={runtime} detail={detail} canonicalId={a.canonicalApplicationId} onSaved={() => { void reload(); }} /><ActivityForm runtime={runtime} detail={detail} mode="task" canonicalId={a.canonicalApplicationId} contacts={contacts} onSaved={() => { void reload(); }} /></>}
    <section className="detail-panel" aria-label="Contatos opcionais"><h3>Contatos opcionais</h3><p>Catálogo de contatos do seu espaço. Salvar um contato não o vincula a este processo; a associação exige escolhê-lo em uma próxima ação.</p>{catalog.isPending && <p role="status">Carregando catálogo de contatos…</p>}{catalog.isError && <><p role="alert">Não foi possível carregar o catálogo de contatos.</p><button onClick={() => { void catalog.refetch(); }}>Reler contatos</button></>}{!contacts.length && !catalog.isPending && !catalog.isError && <p>Nenhum contato informado. Você pode acompanhar o processo sem contato.</p>}{contacts.map((contact) => <article className="detail-contact" key={contact.id}><h4>{contact.name || 'Contato sem nome informado'}</h4><p>{detail.contacts.some((c) => c.id === contact.id) ? 'Vinculado a este processo' : 'Sem vínculo informado com este processo'}</p><p className="preserved-text">{contact.notes || 'Sem notas.'}</p>{contact.links.map((link, i) => <SafeLink key={i} value={link.originalUrl} isLocal={link.isLocal} label={`Referência do contato ${i + 1}`} />)}<button onClick={() => draft.patch({ contactId: contact.id })}>{contact.name ? `Editar contato ${contact.name}` : 'Editar contato sem nome'}</button></article>)}</section>
    {editingContact && <ActivityForm key={editingContact.id} runtime={runtime} detail={detail} mode="contact" contact={editingContact} onUseContact={useContact} onSaved={() => { void reload(); void catalog.refetch(); }} />}
    <ActivityForm runtime={runtime} detail={detail} mode="contact" onUseContact={useContact} onSaved={() => { void catalog.refetch(); }} />
    {!readOnly && <ApplicationActions key={actionsRevision} runtime={runtime} detail={detail} onReload={() => { void reloadAction(); }} />}
  </div>;
}
