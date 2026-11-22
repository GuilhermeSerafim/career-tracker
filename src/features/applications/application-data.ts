import type { AppRuntime } from '../../app/runtime';
import { ApiError, createSaveIntent } from '../../lib/api';
import type { CurrentVersion } from '../../lib/api';
import { commandSchema } from '../../../shared/commands';
import type { Command } from '../../../shared/commands';
import type { ApplicationResult } from '../../../shared/application-results';
import type { DateValue, Stage, SubmissionStatus, CycleRelation, OpportunityKind, EventKind, EventState, EvidenceKind } from '../../../shared/model';
import type { DateEditorState } from '../../components/DateField';

export type Application = NonNullable<ApplicationResult['application']>;
export type Resume = NonNullable<ApplicationResult['resumeRef']>;
export interface DetailLink { originalUrl: string; kind: string; isLocal: boolean; isPrivate: boolean }
export interface DetailContact { id: string; version: number; name: string | null; notes: string | null; links: DetailLink[] }
export interface DetailTask { id: string; version: number; applicationId: string | null; contactId: string | null; title: string; status: 'pending' | 'completed' | 'cancelled'; dueDate: DateValue; completedDate: DateValue }
export interface DetailEvent { id: string; version: number; applicationId: string; kind: EventKind; state: EventState; occurredDate: DateValue; resultText: string | null; scoreValue: number | null; scoreUnit: string | null; sourceText: string | null; evidenceId: string | null; supersedesEventId: string | null; recordedAt: string; superseded: boolean }
export interface DetailEvidence { id: string; kind: EvidenceKind; originalText: string | null; source: string | null; occurredDate: DateValue | null; privateRef: string | null; localRef: string | null }
export interface Detail { application: Application; links: DetailLink[]; resumeRefs: Resume[]; tasks: DetailTask[]; events: DetailEvent[]; contacts: DetailContact[]; evidence: DetailEvidence[]; affectedBatches: { id: string; version: number }[] }
export interface ApplicationPage { items: Application[]; total: number; nextCursor: string | null }
export const stages: Record<Stage, string> = { desconhecida: 'Etapa não informada', candidatura_enviada: 'Aguardando retorno', triagem: 'Triagem', avaliacao: 'Avaliação', entrevista: 'Entrevista', proposta: 'Proposta', contratacao: 'Contratação', rejeicao: 'Rejeição', desistencia: 'Desistência', processo_encerrado: 'Processo encerrado' };
export const statuses: Record<SubmissionStatus, string> = { confirmado: 'Envio confirmado', nao_confirmado: 'Envio desconhecido', nao_enviado: 'Oportunidade salva' };
export const eventKinds: Partial<Record<EventKind, string>> = { nota: 'Nota', retorno_substantivo: 'Retorno substantivo', confirmacao_automatica: 'Confirmação automática', avaliacao: 'Avaliação', entrevista: 'Entrevista', proposta: 'Proposta', contratacao: 'Contratação', rejeicao: 'Rejeição', desistencia: 'Desistência', encerramento: 'Encerramento', etapa_alterada: 'Etapa informada', correcao: 'Correção auditada', envio_confirmado: 'Envio confirmado' };
export const eventStates: Record<EventState, string> = { convidado: 'Convite', agendado: 'Agendado', concluido: 'Concluído', informado: 'Informado' };
export const unknownDate: DateValue = { precision: 'unknown', value: null };
export const nullable = (text: string) => text.trim() ? text : null;
export const split = (text: string) => text.split(',').map((s) => s.trim()).filter(Boolean);
export const readDetail = (runtime: AppRuntime, id: string) => runtime.api.read<Detail>(`/api/v1/applications/${id}`);
export async function readContacts(runtime: AppRuntime) {
  const contacts: DetailContact[] = []; let cursor: string | null = null;
  do {
    const page: { items: DetailContact[]; nextCursor: string | null } = await runtime.api.read(`/api/v1/contacts?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    contacts.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  return contacts;
}
export async function readResumes(runtime: AppRuntime) {
  const result: Resume[] = []; let cursor: string | null = null;
  do {
    const page: { items: Resume[]; nextCursor: string | null } = await runtime.api.read(`/api/v1/resume-refs?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    result.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  return result;
}
export interface Fields {
  company: string; title: string; platform: string; tenant: string; jobCode: string; track: string; applicationInstance: string;
  kind: OpportunityKind; submissionStatus: SubmissionStatus; submittedDate: DateValue; dateEditor?: DateEditorState;
  stage: Stage; cycleRelation: CycleRelation; stack: string; seniority: string; modality: string; description: string;
  discoveryChannel: string; submissionPlatform: string; notes: string; resumeIds: string[]; links: string; evidence: string;
}
export function fieldsFrom(detail?: Detail): Fields {
  const a = detail?.application; const o = a?.opportunity;
  return { company: o?.company ?? '', title: o?.title ?? '', platform: o?.platform ?? '', tenant: o?.tenant ?? '', jobCode: o?.jobCode ?? '', track: a?.track ?? '', applicationInstance: a?.applicationInstance ?? 'initial', kind: o?.kind ?? 'vaga', submissionStatus: a?.submissionStatus ?? 'confirmado', submittedDate: a?.submittedDate ?? unknownDate, stage: a?.stage ?? 'desconhecida', cycleRelation: a?.cycleRelation ?? 'unknown', stack: o?.stack.join(', ') ?? '', seniority: o?.seniority ?? '', modality: o?.modality ?? '', description: o?.description ?? '', discoveryChannel: a?.discoveryChannel ?? '', submissionPlatform: a?.submissionPlatform ?? '', notes: a?.notes ?? '', resumeIds: a?.resumeIds ?? [], links: '', evidence: '' };
}
export const labels: Partial<Record<keyof Fields, string>> = { company: 'Empresa', title: 'Cargo', track: 'Trilha', applicationInstance: 'Ocorrência', kind: 'Tipo', submittedDate: 'Data do envio', stage: 'Etapa', cycleRelation: 'Relação com o ciclo', stack: 'Stack', seniority: 'Senioridade', modality: 'Modalidade', description: 'Descrição', discoveryChannel: 'Canal de descoberta', submissionPlatform: 'Plataforma de envio', notes: 'Observações', resumeIds: 'Currículo enviado', links: 'Novos links', evidence: 'Relato ou evidência' };
export function comparable(fields: Fields): CurrentVersion['fields'] {
  return Object.fromEntries(Object.entries(labels).map(([key, label]) => { const value = fields[key as keyof Fields]; return [label, typeof value === 'object' ? JSON.stringify(value) : value ?? null]; }));
}
export const evidence = (text: string) => ({ clientId: crypto.randomUUID(), kind: 'relato_usuario' as const, originalText: text, source: 'Registro informado pelo usuário', occurredDate: null, privateRef: null, localRef: null });
export function formCommand(fields: Fields, detail?: Detail): Command {
  const links = fields.links.split('\n').map((s) => s.trim()).filter(Boolean).map((originalUrl, index) => ({ originalUrl, comparisonUrl: null, kind: index ? 'alternativo' : 'original', isLocal: false, isPrivate: true }));
  const proof = nullable(fields.evidence) ? evidence(fields.evidence) : null;
  if (!detail) return commandSchema.parse({ operation: 'save_application', clientId: crypto.randomUUID(), data: {
    opportunity: { company: nullable(fields.company), title: nullable(fields.title), platform: nullable(fields.platform), tenant: nullable(fields.tenant), jobCode: nullable(fields.jobCode), jobKey: null, kind: fields.kind, seniority: nullable(fields.seniority), modality: nullable(fields.modality), description: nullable(fields.description), stack: split(fields.stack), identities: [] },
    track: nullable(fields.track), applicationInstance: fields.applicationInstance, submissionStatus: fields.submissionStatus, submittedDate: fields.submittedDate, stage: fields.stage, cycleRelation: fields.cycleRelation, discoveryChannel: nullable(fields.discoveryChannel), submissionPlatform: nullable(fields.submissionPlatform), notes: nullable(fields.notes), resumeIds: fields.resumeIds, links,
  }, evidence: proof });
  const a = detail.application; const original = fieldsFrom(detail);
  if (fields.track !== original.track && !proof) throw new ApiError(400);
  const changes: Record<string, unknown> = {};
  for (const key of ['track', 'applicationInstance', 'stage', 'discoveryChannel', 'submissionPlatform', 'notes', 'resumeIds'] as const) if (JSON.stringify(fields[key]) !== JSON.stringify(original[key])) changes[key] = typeof fields[key] === 'string' ? nullable(fields[key]) : fields[key];
  if (links.length) changes.links = links;
  const metadata: Record<string, unknown> = {};
  for (const key of ['company', 'title', 'kind', 'seniority', 'modality', 'description', 'stack'] as const) if (fields[key] !== original[key]) metadata[key] = key === 'stack' ? split(fields.stack) : nullable(fields[key]);
  const reconcile = JSON.stringify(fields.submittedDate) !== JSON.stringify(original.submittedDate) || fields.cycleRelation !== original.cycleRelation;
  return commandSchema.parse({ operation: 'update_application', application: { id: a.id, expectedVersion: a.version }, changes,
    ...(Object.keys(metadata).length ? { opportunityPatch: { opportunity: { id: a.opportunity.id, expectedVersion: a.opportunity.version }, changes: metadata } } : {}),
    ...(reconcile ? { reconciliation: { submittedDate: fields.submittedDate, cycleRelation: fields.cycleRelation }, affectedBatches: detail.affectedBatches.map((b) => ({ id: b.id, expectedVersion: b.version })) } : {}), evidence: proof });
}

/** Raw business input lives above the route boundary; command intentions are frozen separately. */
export function createFormDraft(runtime: AppRuntime, initial?: Detail, onSaved?: () => void) {
  let state = { fields: fieldsFrom(initial), detail: initial, savedDetail: initial, canonicalId: initial?.application.canonicalApplicationId ?? null, uncertain: false, intent: null as ReturnType<typeof createSaveIntent<Command, ApplicationResult>> | null, error: '', checking: false, refreshing: false, revisionRequested: false, revising: false, cycleState: '', candidates: [] as Application[] };
  let latest = initial;
  let disposed = false;
  const generation = runtime.auth.getSnapshot().generation;
  const alive = () => !disposed && runtime.auth.getSnapshot().generation === generation;
  const active = () => alive() && runtime.auth.getSnapshot().status === 'authenticated';
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const update = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; publish(); };
  let disconnect = () => {};
  const controller = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    patch: (patch: Partial<Fields>) => update({ fields: { ...state.fields, ...patch }, error: '', candidates: [] }),
    refreshSaved: async () => {
      if (!active() || !state.detail || state.refreshing) return false;
      update({ refreshing: true, error: '' });
      try {
        const savedDetail = await readDetail(runtime, state.detail.application.id);
        if (!active()) return false;
        // The independent draft and submitted command still compare against their original basis.
        update({ savedDetail, canonicalId: savedDetail.application.canonicalApplicationId }); return true;
      } catch { if (active()) update({ error: 'Não foi possível atualizar o registro salvo. Seu rascunho e a decisão salva foram mantidos; tente atualizar novamente.' }); return false; }
      finally { if (alive()) update({ refreshing: false }); }
    },
    requestRevision: async () => {
      const intent = state.intent; const rejected = intent?.getSnapshot().error?.status;
      if (!active() || !intent || state.refreshing || !(state.revisionRequested || rejected === 400 || !state.detail && rejected === 409)) return;
      update({ revisionRequested: true, refreshing: true, revising: false, error: '' });
      const outcome = await intent.refresh();
      if (!active()) { if (alive()) update({ refreshing: false }); return; }
      update({ refreshing: false, revising: outcome.status === 'ready', error: outcome.status === 'ready' ? '' : 'Não foi possível reler para revisar. Seus dados e a intenção original foram mantidos.' });
    },
    begin: async (command?: Command, distinct = false) => {
      try {
        if (!active() || state.canonicalId || state.intent && !state.revising || state.checking) return;
        const draft = command ?? formCommand(state.fields, state.detail);
        if (!command && !state.detail && state.fields.company && state.fields.title && !distinct) {
          const basis = state.fields; update({ checking: true });
          const matches = await runtime.api.read<ApplicationPage>(`/api/v1/applications?view=all&limit=100&filters=${encodeURIComponent(JSON.stringify({ company: [basis.company], title: [basis.title], archived: 'include' }))}`);
          update({ checking: false });
          if (!active() || state.fields !== basis) return;
          if (matches.items.length) { update({ candidates: matches.items }); return; }
        }
        if (distinct && !state.fields.evidence.trim()) { update({ error: 'Explique com evidência por que esta candidatura é distinta.' }); return; }
        if (state.revising && state.intent && !state.detail) {
          state.intent.reapply(draft); update({ revising: false, revisionRequested: false, candidates: [] }); return;
        }
        const intent = createSaveIntent<Command, ApplicationResult>({ auth: runtime.auth, api: runtime.api, draft,
          readCurrent: async () => {
            if (!state.detail) {
              const cycle = await runtime.api.read<{ state: string }>('/api/v1/batches?limit=1');
              if (active()) update({ cycleState: cycle.state });
              return { versions: {}, fields: { 'Ciclo atual': cycle.state === 'not_started' ? 'Não iniciado' : 'Iniciado' } };
            }
            latest = await readDetail(runtime, state.detail.application.id);
            const a = latest.application;
            if (active()) update({ canonicalId: a.canonicalApplicationId });
            return { versions: { [a.id]: a.version, [a.opportunity.id]: a.opportunity.version, ...Object.fromEntries(latest.affectedBatches.map((b) => [b.id, b.version])) }, fields: comparable(fieldsFrom(latest)) };
          } });
        disconnect = intent.subscribe(() => {
          const snapshot = intent.getSnapshot();
          update({ ...(state.revising && !snapshot.current ? { revising: false } : {}), uncertain: snapshot.status === 'unavailable' ? true : ['saved', 'conflict'].includes(snapshot.status) ? false : state.uncertain });
          if (snapshot.status === 'saved') onSaved?.();
        }); update({ intent }); void intent.save();
      } catch { update({ checking: false, error: 'Não foi possível preparar o registro. Confira os campos ou tente novamente. Confirmação, nova ocorrência e correção de data/ciclo exigem relato ou evidência. Informe apenas links HTTP(S) válidos.' }); }
    },
    reapply: (selected: readonly string[]) => {
      if (!latest || !state.intent || latest.application.canonicalApplicationId) throw new ApiError(409);
      const next = fieldsFrom(latest);
      for (const key of Object.keys(labels) as (keyof Fields)[]) if (selected.includes(labels[key]!)) Object.assign(next, { [key]: state.fields[key] });
      if (selected.includes(labels.submittedDate!)) next.dateEditor = state.fields.dateEditor;
      state.intent.reapply(formCommand(next, latest));
      update({ fields: next, detail: latest, savedDetail: latest, uncertain: false, revising: false, revisionRequested: false });
    },
    dispose: () => { disposed = true; disconnect(); state.intent?.dispose(); state = { fields: fieldsFrom(), detail: undefined, savedDetail: undefined, canonicalId: null, uncertain: false, intent: null, error: '', checking: false, refreshing: false, revisionRequested: false, revising: false, cycleState: '', candidates: [] }; listeners.clear(); },
  };
  return controller;
}
export type FormDraft = ReturnType<typeof createFormDraft>;
