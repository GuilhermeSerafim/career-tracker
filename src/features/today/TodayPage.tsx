import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useId, useState } from 'react';
import type { AppRuntime } from '../../app/runtime';
import { SafeLink } from '../../components/SafeLink';
import { displayDate, readToday } from './today-data';
import type { Application, Contact, TodayResult } from './today-data';
import './today.css';

const deadlineLabels = { overdue: 'Atrasada', today: 'Hoje', future: 'Futura', no_exact_deadline: 'Sem prazo exato' };
const eventLabels = { envio_confirmado: 'Envio confirmado', etapa_alterada: 'Etapa alterada', retorno_substantivo: 'Retorno', confirmacao_automatica: 'Confirmação automática', avaliacao: 'Avaliação', entrevista: 'Entrevista', proposta: 'Proposta', contratacao: 'Contratação', rejeicao: 'Rejeição', desistencia: 'Desistência', encerramento: 'Encerramento', nota: 'Nota', correcao: 'Correção' };
const stateLabels = { convidado: 'Convite', agendado: 'Agendado', concluido: 'Concluído', informado: 'Informado' };

function ContactAction({ runtime, id, title }: { runtime: AppRuntime; id: string; title: string }) {
  const [open, setOpen] = useState(false);
  const sectionId = useId();
  const contact = useQuery({ queryKey: ['contact', runtime.auth.getSnapshot().generation, runtime.getAccessPeriod(), id], queryFn: () => runtime.api.read<Contact>(`/api/v1/contacts/${id}`), enabled: open });
  return <><button type="button" className="today-contact-trigger today-task-link" aria-expanded={open} aria-controls={sectionId} onClick={() => setOpen(!open)}>{title}<span aria-hidden="true">{open ? '−' : '+'}</span></button>
    {open && <section className="today-contact" id={sectionId} aria-label="Detalhes da conversa">
      {contact.isPending && <p role="status">Carregando conversa…</p>}
      {contact.isError && <><p role="alert">Não foi possível carregar esta conversa.</p><button type="button" onClick={() => { void contact.refetch(); }} disabled={contact.isFetching}>Tentar novamente</button></>}
      {!contact.isError && contact.data && <><h3>{contact.data.name ?? 'Nome não informado'}</h3>{contact.data.notes && <p>{contact.data.notes}</p>}{contact.data.links.length ? <ul>{contact.data.links.map((link, index) => <li key={index}><SafeLink value={link.originalUrl} isLocal={link.isLocal} label={`Abrir conversa ${index + 1}`} /></li>)}</ul> : <p>Nenhum link de conversa informado.</p>}</>}
    </section>}
  </>;
}

function ApplicationLabel({ application }: { application: Application }) {
  return <span className="today-application">{application.opportunity.company ?? 'Empresa não informada'} · {application.opportunity.title ?? 'Cargo não informado'} <span className="today-id">{application.displayId}</span></span>;
}
function Events({ events, applications, timezone, historical = false }: { events: TodayResult['recentEvents']; applications: Map<string, Application>; timezone: string; historical?: boolean }) {
  return <section className="today-panel" aria-labelledby={historical ? 'historical-title' : 'recent-title'}>
    <p className="eyebrow">{historical ? 'Além do ciclo atual' : 'Seu caminho'}</p>
    <h2 id={historical ? 'historical-title' : 'recent-title'}>{historical ? 'Resultados de processos anteriores' : 'Movimentações recentes'}</h2>
    {historical && <p className="today-muted">Resultados anteriores ficam separados do progresso de novos envios.</p>}
    {events.length === 0 ? <p className="today-muted">{historical ? 'Nenhum resultado anterior registrado.' : 'Nenhuma movimentação recente registrada.'}</p> : <ul className="today-events">{events.map((event) => <li key={event.id}>
      <div className="today-event-heading"><Link className="text-action" to={`/vagas/${event.canonicalApplicationId}`}>{eventLabels[event.kind]} <span aria-hidden="true">↗</span></Link><span className="today-state">{stateLabels[event.state]}</span></div>
      <ApplicationLabel application={applications.get(event.canonicalApplicationId)!} />
      {event.resultText && <p className="today-result">{event.resultText}</p>}
      {event.scoreValue !== null && <p className="today-result">Resultado informado: {event.scoreValue} {event.scoreUnit ?? '(unidade não informada)'}</p>}
      <p className="today-dates">{event.occurredDate.precision === 'unknown' ? 'Data do acontecimento desconhecida' : `Aconteceu em ${displayDate(event.occurredDate, timezone)}`}<br />Registrado em {displayDate({ precision: 'instant', certainty: 'exact', value: event.recordedAt }, timezone)}</p>
    </li>)}</ul>}
    {events.length === 5 && <p className="today-muted today-list-note">Últimas cinco movimentações. Veja o histórico completo em cada candidatura.</p>}
  </section>;
}

export function TodayPage({ runtime }: { runtime: AppRuntime }) {
  const query = useQuery({ queryKey: ['today', runtime.auth.getSnapshot().generation, runtime.getAccessPeriod()], queryFn: () => readToday(runtime), refetchInterval: 60_000 });
  const data = !query.isError ? query.data : undefined;
  return <div className="today-page">
    <section className="page-intro today-intro"><div><p className="eyebrow">Hoje{data && ` · ${displayDate({ precision: 'day', certainty: 'exact', value: data.today.date }, data.timezone)}`}</p><h1 tabIndex={-1}>Seu próximo passo.</h1><p className="intro-description">Uma candidatura, uma conversa, um passo de cada vez.</p></div><Link className="today-register" to="/vagas/nova">Registrar candidatura <span aria-hidden="true">↗</span></Link></section>
    {query.isPending && <p role="status" className="today-panel">Carregando sua rotina…</p>}
    {query.isError && <section className="today-panel today-error"><h2>Sua rotina está indisponível</h2><p role="alert">Não foi possível carregar sua rotina. Tente novamente.</p><button type="button" onClick={() => { void query.refetch(); }} disabled={query.isFetching}>{query.isFetching ? 'Tentando novamente…' : 'Tentar novamente'}</button></section>}
    {data && <>
      <section className="today-goal" aria-labelledby="goal-title"><div><p className="eyebrow">Um pouco a cada dia</p><h2 id="goal-title">Meta de hoje</h2><p className="today-count"><strong>{data.today.submitted.count}</strong> de {data.today.dailyGoal}</p><p>candidaturas confirmadas com dia exato de envio</p></div><div className="today-goal-detail"><p>{data.today.submitted.count >= data.today.dailyGoal ? 'Meta alcançada. Siga no seu ritmo.' : `Faltam ${data.today.dailyGoal - data.today.submitted.count} para sua meta de hoje.`}</p><progress aria-label="Progresso da meta diária" value={Math.min(data.today.submitted.count, data.today.dailyGoal)} max={data.today.dailyGoal} /><p className="today-zone">Horário de referência: {data.timezone}</p></div></section>
      {data.today.unknownDateApplicationIds.length > 0 && <p className="today-coverage">{data.today.unknownDateApplicationIds.length} {data.today.unknownDateApplicationIds.length === 1 ? 'candidatura sem dia exato de envio fica fora' : 'candidaturas sem dia exato de envio ficam fora'} da contagem diária.</p>}
      {data.today.submitted.count === 0 && data.today.recentEvents.length === 0 && data.today.historicalResults.length === 0 && data.today.unknownDateApplicationIds.length === 0 && data.today.tasks.length === 0 && <p className="today-empty">Registre sua primeira candidatura para começar seu acompanhamento.</p>}
      <section className="today-panel today-actions" aria-labelledby="actions-title"><div className="today-section-heading"><div><p className="eyebrow">O que vem agora</p><h2 id="actions-title">Próximas ações</h2></div><span className="today-total">{data.today.tasks.length} pendentes</span></div>
        {data.today.tasks.length === 0 ? <p className="today-muted">Nenhuma ação pendente.</p> : <ol className="today-tasks">{data.today.tasks.map((task) => <li key={task.id}><div className="today-deadline"><span className={`today-due today-due-${task.dueGroup}`}>{deadlineLabels[task.dueGroup]}</span><span>{displayDate(task.dueDate, data.timezone)}</span></div><div className="today-task-copy">{task.applicationId ? <><Link className="today-task-link" to={`/vagas/${task.applicationId}`}>{task.title}<span aria-hidden="true">↗</span></Link><ApplicationLabel application={data.applications.get(task.applicationId)!} />{task.contactId && <ContactAction runtime={runtime} id={task.contactId} title="Ver conversa vinculada" />}</> : task.contactId && <ContactAction runtime={runtime} id={task.contactId} title={task.title} />}</div></li>)}</ol>}
      </section>
      <div className="today-activity"><Events events={data.recent} applications={data.applications} timezone={data.timezone} /><Events events={data.historical} applications={data.applications} timezone={data.timezone} historical /></div>
    </>}
    <p className="page-footnote">Seu espaço. Seu ritmo.</p>
  </div>;
}
