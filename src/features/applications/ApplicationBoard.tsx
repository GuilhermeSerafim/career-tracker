import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
interface MovePreview { stage: Stage; version: number; confirmed: boolean }

export function ApplicationBoard({ runtime, items }: { runtime: AppRuntime; items: Application[] }) {
  const prefix = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<DraggedCard | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<Stage | null>(null);
  const [moves, setMoves] = useState<Record<string, MovePreview>>({});
  const [lastMove, setLastMove] = useState('');
  const notified = useRef(new Map<string, number>());
  const focusAfterMove = useRef<string | null>(null);
  const grouped = new Map(stageOrder.map((stage) => [stage, [] as Application[]]));
  for (const item of items) {
    const preview = moves[item.id];
    const displayStage = preview && (preview.confirmed ? preview.version > item.version : preview.version >= item.version)
      ? preview.stage : item.stage;
    grouped.get(displayStage)!.push(item);
  }

  useEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    if (document.activeElement === document.body) {
      const card = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-board-card]') ?? [])]
        .find((item) => item.dataset.boardCard === id);
      card?.querySelector('a')?.focus();
    }
    if (moves[id]?.confirmed !== false) focusAfterMove.current = null;
  }, [items, moves]);

  const onMoveState = useCallback((id: string, version: number, preview?: MovePreview) => {
    setMoves(current => {
      const existing = current[id];
      if (preview && (!preview.confirmed || preview.version > version)) {
        if (existing?.stage === preview.stage && existing.version === preview.version && existing.confirmed === preview.confirmed) return current;
        return { ...current, [id]: preview };
      }
      if (!existing || existing.confirmed && existing.version > version) return current;
      const remaining = { ...current };
      delete remaining[id];
      return remaining;
    });
    if (preview?.confirmed && (notified.current.get(id) ?? 0) < preview.version) {
      notified.current.set(id, preview.version);
      setLastMove('Etapa registrada.');
    } else if (preview && !preview.confirmed) {
      setLastMove('');
    }
  }, []);

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
    <p className="stage-board-feedback" role="status">{lastMove}</p>
    <div className="stage-board-scroller" ref={scroller} role="region" aria-label="Colunas de etapas" tabIndex={0}>
      <div className="stage-board-columns">
        {stageOrder.map((stage) => {
          const group = grouped.get(stage)!;
          const id = `${prefix}-${stage}`;
          return <section key={stage} id={id} aria-labelledby={`${id}-heading`} className="stage-board-column"
            data-target={target === stage} onDragOver={(event) => over(event, stage)} onDrop={(event) => drop(event, stage)}>
            <h2 id={`${id}-heading`} tabIndex={-1}>{stages[stage]} <small>{group.length}</small></h2>
            {group.length ? group.map((a) => <BoardCard key={`${a.id}:${a.version}`} runtime={runtime} application={a} displayStage={stage}
              dragging={dragging === a.id} onDragStart={start} onDragEnd={end}
              onMoveState={onMoveState} rememberFocus={(id) => { focusAfterMove.current = id; }} />)
              : <p className="stage-board-empty">Nenhum cartão nesta etapa</p>}
          </section>;
        })}
      </div>
    </div>
  </section>;
}

function BoardCard({ runtime, application: a, displayStage, dragging, onDragStart, onDragEnd, onMoveState, rememberFocus }: {
  runtime: AppRuntime; application: Application; displayStage: Stage; dragging: boolean; onDragStart(event: DragEvent<HTMLElement>, card: DraggedCard): void;
  onDragEnd(): void; onMoveState(id: string, version: number, preview?: MovePreview): void; rememberFocus(id: string | null): void;
}) {
  const draftKey = `board:${a.id}`;
  const [draft] = useState(() => {
    const create = () => createFormDraft(runtime,
      { application: a, links: [], resumeRefs: [], tasks: [], events: [], contacts: [], evidence: [], affectedBatches: [] },
      () => { void runtime.query.invalidateQueries({ queryKey: ['applications'] }); });
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
  const confirmed = save?.status === 'saved' ? save.result?.application : null;
  const command = save?.status === 'saving' && save.draft?.operation === 'update_application' ? save.draft : null;
  const locked = Boolean(save || state.canonicalId || displayStage !== a.stage);
  useEffect(() => {
    const preview = confirmed ? { stage: confirmed.stage, version: confirmed.version, confirmed: true }
      : command?.changes.stage ? { stage: command.changes.stage, version: command.application.expectedVersion, confirmed: false } : undefined;
    onMoveState(a.id, a.version, preview);
  }, [a.id, a.version, command, confirmed, onMoveState]);

  function move(stage: Stage, focus: boolean) {
    if (draft.getSnapshot().intent || state.canonicalId || stage === a.stage) return;
    rememberFocus(focus ? a.id : null);
    draft.patch({ stage });
    void draft.begin({ operation: 'update_application', application: { id: a.id, expectedVersion: a.version }, changes: { stage }, affectedBatches: [] });
  }

  return <article className="stage-board-card" data-board-card={a.id} data-stage={displayStage} data-dragging={dragging} draggable={!locked}
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
    {command && <p role="status">Salvando etapa…</p>}
    {save?.status === 'unavailable' && <p>A mudança voltou à etapa anterior. Repita o movimento para confirmar o resultado.</p>}
    {save?.error && <p role="alert">{save.error.message}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {save && ['unavailable', 'error', 'editing'].includes(save.status) && <button type="button" onClick={(event) => { rememberFocus(document.activeElement === event.currentTarget ? a.id : null); void state.intent!.save(); }}>Repetir movimento original</button>}
    {save?.status === 'refresh-required' && <button type="button" onClick={() => { void state.intent!.refresh(); }}>Reler acesso</button>}
    {save && ['conflict', 'refresh-required'].includes(save.status) && <><button type="button" onClick={() => setConflictOpen(true)}>Comparar etapa</button>
      {conflictOpen && <ConflictDialog local={{ Etapa: stages[state.fields.stage] }} current={comparison} reapplyBlocked={Boolean(state.canonicalId)}
        onRefresh={() => state.intent!.refresh()} onReapply={(selected) => { draft.reapply(selected); setConflictOpen(false); }}
        onClose={() => setConflictOpen(false)} />}</>}
  </article>;
}
