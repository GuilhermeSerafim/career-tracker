import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DragEvent } from 'react';
import { Link } from 'react-router';
import type { Stage } from '../../../shared/model';
import type { AppRuntime } from '../../app/runtime';
import { ConflictDialog } from '../../components/ConflictDialog';
import { displayDate } from '../today/today-data';
import { createFormDraft, stages, statuses } from './application-data';
import type { Application } from './application-data';
import './board.css';

const stageOrder = Object.keys(stages) as Stage[];

interface DraggedCard { id: string; stage: Stage; move(stage: Stage): void }
interface BoardMove { id: string; stage: Stage; focus: boolean }

export function ApplicationBoard({ runtime, items }: { runtime: AppRuntime; items: Application[] }) {
  const prefix = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<DraggedCard | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<Stage | null>(null);
  const [lastMove, setLastMove] = useState<BoardMove>();
  const restoredFocus = useRef<BoardMove | undefined>(undefined);
  const grouped = new Map(stageOrder.map((stage) => [stage, [] as Application[]]));
  for (const item of items) grouped.get(item.stage)!.push(item);

  useEffect(() => {
    if (!lastMove?.focus || restoredFocus.current === lastMove || document.activeElement !== document.body) return;
    const card = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-board-card]') ?? [])]
      .find((item) => item.dataset.boardCard === lastMove.id && item.dataset.stage === lastMove.stage);
    if (card) {
      restoredFocus.current = lastMove;
      card.querySelector('a')?.focus();
    }
  }, [items, lastMove]);

  function start(event: DragEvent<HTMLElement>, card: DraggedCard) {
    event.dataTransfer.setData('application/x-career-stage-card', 'move');
    event.dataTransfer.effectAllowed = 'move';
    drag.current = card;
    setDragging(card.id);
  }

  function end() {
    drag.current = null;
    setDragging(null);
    setTarget(null);
  }

  function over(event: DragEvent<HTMLElement>, stage: Stage) {
    if (!drag.current) return;
    const canMove = drag.current.stage !== stage;
    event.preventDefault();
    event.dataTransfer.dropEffect = canMove ? 'move' : 'none';
    setTarget(canMove ? stage : null);
    const container = scroller.current;
    if (!container || !Number.isFinite(event.clientX)) return;
    const { left, right } = container.getBoundingClientRect();
    const edge = 45;
    if (event.clientX > right - edge && event.clientX <= right) container.scrollLeft += edge;
    if (event.clientX < left + edge && event.clientX >= left) container.scrollLeft -= edge;
  }

  function drop(event: DragEvent<HTMLElement>, stage: Stage) {
    if (!drag.current) return;
    event.preventDefault();
    const card = drag.current;
    end();
    if (card.stage !== stage) card.move(stage);
  }

  function jump(stage: Stage) {
    const container = scroller.current;
    const column = document.getElementById(`${prefix}-${stage}`);
    if (!container || !column) return;
    const left = column.getBoundingClientRect().left - container.getBoundingClientRect().left + container.scrollLeft - 3;
    container.scrollTo?.({ left, top: 0 });
    column.querySelector('h2')?.focus({ preventScroll: true });
  }

  return <section className="stage-board" aria-label="Quadro por etapa">
    <div className="stage-board-toolbar">
      <div>
        <p>As colunas mostram a última etapa registrada. Cada cartão também mostra a situação do envio.</p>
        <p className="stage-board-hint">Arraste um cartão entre colunas ou use o botão Mover. Ao mover, você atualiza a etapa do processo.</p>
      </div>
      <label>Ir para uma etapa
        <select defaultValue="" onChange={(event) => {
          if (event.currentTarget.value) jump(event.currentTarget.value as Stage);
          event.currentTarget.value = '';
        }}>
          <option value="">Escolher etapa</option>
          {stageOrder.map((stage) => <option key={stage} value={stage}>{stages[stage]} ({grouped.get(stage)!.length})</option>)}
        </select>
      </label>
    </div>
    <p className="stage-board-feedback" role="status">{lastMove && <>Etapa registrada.</>}</p>
    <div className="stage-board-scroller" ref={scroller} role="region" aria-label="Colunas de etapas" tabIndex={0}>
      <div className="stage-board-columns">
        {stageOrder.map((stage) => {
          const group = grouped.get(stage)!;
          const id = `${prefix}-${stage}`;
          return <section key={stage} id={id} aria-labelledby={`${id}-heading`} className="stage-board-column"
            data-target={target === stage} onDragOver={(event) => over(event, stage)} onDrop={(event) => drop(event, stage)}>
            <h2 id={`${id}-heading`} tabIndex={-1}>{stages[stage]} <small>{group.length}</small></h2>
            {group.length ? group.map((a) => <BoardCard key={`${a.id}:${a.version}`} runtime={runtime} application={a}
              dragging={dragging === a.id} onDragStart={start} onDragEnd={end}
              onSaved={(move) => { setLastMove(move); void runtime.query.invalidateQueries({ queryKey: ['applications'] }); }} />)
              : <p className="stage-board-empty">Nenhum cartão nesta etapa</p>}
          </section>;
        })}
      </div>
    </div>
  </section>;
}

function BoardCard({ runtime, application: a, dragging, onDragStart, onDragEnd, onSaved }: {
  runtime: AppRuntime; application: Application; dragging: boolean; onDragStart(event: DragEvent<HTMLElement>, card: DraggedCard): void;
  onDragEnd(): void; onSaved(move: BoardMove): void;
}) {
  const draftKey = `board:${a.id}`;
  const [draft] = useState(() => {
    const create = () => createFormDraft(runtime, { application: a, links: [], resumeRefs: [], tasks: [], events: [], contacts: [], evidence: [], affectedBatches: [] });
    const retained = runtime.retainDraft(draftKey, create);
    const { detail, intent } = retained.getSnapshot();
    if (detail?.application.version !== a.version && (!intent || intent.getSnapshot().status === 'saved')) {
      runtime.abandonDraft(draftKey);
      return runtime.retainDraft(draftKey, create);
    }
    return retained;
  });
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const save = state.intent?.getSnapshot();
  const currentVersion = save?.current;
  const comparison = useMemo(() => currentVersion ? { ...currentVersion,
    fields: { Etapa: stages[currentVersion.fields.Etapa as Stage] ?? currentVersion.fields.Etapa ?? null },
  } : null, [currentVersion]);
  const [conflictOpen, setConflictOpen] = useState(true);
  const notified = useRef(false);
  const restoreFocus = useRef(false);
  const locked = Boolean(save || state.canonicalId);
  useEffect(() => {
    if (save?.status !== 'saved' || notified.current) return;
    notified.current = true;
    onSaved({ id: a.id, stage: save.result?.application?.stage ?? state.fields.stage, focus: restoreFocus.current });
  }, [a.id, onSaved, save, state.fields.stage]);

  function move(stage: Stage, focus: boolean) {
    if (draft.getSnapshot().intent || state.canonicalId || stage === a.stage) return;
    restoreFocus.current = focus;
    draft.patch({ stage });
    void draft.begin({ operation: 'update_application', application: { id: a.id, expectedVersion: a.version }, changes: { stage }, affectedBatches: [] });
  }

  return <article className="stage-board-card" data-board-card={a.id} data-stage={a.stage} data-dragging={dragging} draggable={!locked}
    onDragStart={(event) => {
      if (locked || event.target !== event.currentTarget) { event.preventDefault(); return; }
      onDragStart(event, { id: a.id, stage: a.stage, move: (stage) => move(stage, false) });
    }} onDragEnd={onDragEnd}>
    <p className="stage-board-card-id">{a.displayId}{a.archivedAt && ' · Arquivada'}</p>
    <h3><Link to={`/vagas/${a.id}`} draggable={false}>{a.opportunity.company ?? 'Empresa não informada'} · {a.opportunity.title ?? 'Cargo não informado'}</Link></h3>
    {a.track && <p className="stage-board-card-track">{a.track}</p>}
    <p className="stage-board-send"><span data-submission={a.submissionStatus}>{statuses[a.submissionStatus]}</span>
      {a.submissionStatus !== 'nao_enviado' && <span>{a.submittedDate.precision === 'unknown'
        ? 'Data de envio não informada' : `Envio em ${displayDate(a.submittedDate, 'America/Sao_Paulo')}`}</span>}</p>
    <div className="stage-board-card-controls">
      <select aria-label={`Etapa de ${a.displayId}`} value={state.fields.stage} disabled={locked}
        onChange={(event) => draft.patch({ stage: event.target.value as Stage })}>
        {stageOrder.map((stage) => <option key={stage} value={stage}>{stage === a.stage ? 'Mover para…' : stages[stage]}</option>)}
      </select>
      <button type="button" aria-label={`Mover ${a.displayId}`} disabled={locked || state.fields.stage === a.stage}
        onClick={(event) => move(state.fields.stage, document.activeElement === event.currentTarget)}>Mover</button>
    </div>
    {save?.status === 'saving' && <p role="status">Movendo para {stages[state.fields.stage]}…</p>}
    {save?.error && <p role="alert">{save.error.message}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {save && ['unavailable', 'error', 'editing'].includes(save.status) && <button type="button" onClick={() => { void state.intent!.save(); }}>Repetir movimento original</button>}
    {save?.status === 'refresh-required' && <button type="button" onClick={() => { void state.intent!.refresh(); }}>Reler acesso</button>}
    {save && ['conflict', 'refresh-required'].includes(save.status) && <><button type="button" onClick={() => setConflictOpen(true)}>Comparar etapa</button>
      {conflictOpen && <ConflictDialog local={{ Etapa: stages[state.fields.stage] }} current={comparison} reapplyBlocked={Boolean(state.canonicalId)}
        onRefresh={() => state.intent!.refresh()} onReapply={(selected) => { draft.reapply(selected); setConflictOpen(false); }}
        onClose={() => setConflictOpen(false)} />}</>}
  </article>;
}
