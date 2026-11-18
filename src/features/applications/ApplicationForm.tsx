import { useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { AppRuntime } from '../../app/runtime';
import { DateField } from '../../components/DateField';
import { ConflictDialog } from '../../components/ConflictDialog';
import { SafeLink } from '../../components/SafeLink';
import { comparable, createFormDraft, readDetail, readResumes, stages, statuses } from './application-data';
import type { Detail, Fields } from './application-data';
import './applications.css';
import { ResumeCreator } from './ResumeCreator';
import { ApplicationActions } from './ApplicationActions';
import { ApiError } from '../../lib/api';

export function ApplicationForm({ runtime }: { runtime: AppRuntime }) {
  const { id } = useParams();
  const [revision, setRevision] = useState(0);
  const [resetting, setResetting] = useState(false);
  const detail = useQuery({ queryKey: ['application-edit', id, runtime.auth.getSnapshot().generation, runtime.getAccessPeriod()], queryFn: () => readDetail(runtime, id!), enabled: !!id });
  const reset = async () => {
    setResetting(true);
    const key = `application-form:${id ?? 'new'}`;
    runtime.abandonDraft(key); runtime.abandonDraft(`${key}:resume`);
    if (id) { runtime.abandonDraft(`application-actions:${id}`); await detail.refetch(); }
    setRevision((value) => value + 1); setResetting(false);
  };
  return <><section className="page-intro"><p className="eyebrow">Uma oportunidade de cada vez</p><h1 tabIndex={-1}>Vagas</h1><p>{id ? 'Atualizar registro' : 'Registrar candidatura'}</p><Link to="/vagas">Voltar para a lista</Link>{id && <p><Link to={`/vagas/${id}`}>Ver histórico e acompanhamento</Link></p>}</section>
    {resetting || id && detail.isPending ? <p role="status">Carregando registro…</p> : id && detail.isError ? <><p role="alert">Não foi possível carregar o registro.</p><button onClick={() => { void detail.refetch(); }}>Tentar novamente</button></> : <Editor key={`${id ?? 'new'}:${revision}`} runtime={runtime} detail={detail.data} onReset={() => { void reset(); }} />}</>;
}
function Editor({ runtime, detail, onReset }: { runtime: AppRuntime; detail?: Detail; onReset(): void }) {
  const key = `application-form:${detail?.application.id ?? 'new'}`;
  const [draft] = useState(() => runtime.retainDraft(key, () => createFormDraft(runtime, detail)));
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const [validDate, setValidDate] = useState(true);
  const [conflictOpen, setConflictOpen] = useState(true);
  const [actionsRevision, setActionsRevision] = useState(0);
  const refs = useQuery({ queryKey: ['resume-refs', runtime.auth.getSnapshot().generation, runtime.getAccessPeriod()], queryFn: () => readResumes(runtime) });
  const f = state.fields; const save = state.intent?.getSnapshot();
  const canonicalId = state.canonicalId ?? detail?.application.canonicalApplicationId;
  const locked = !!canonicalId || !!save && !state.revising || state.checking || state.refreshing;
  const field = (name: keyof Fields, label: string, options: { multiline?: boolean; disabled?: boolean; required?: boolean } = {}) => <label>{label}{options.multiline ? <textarea value={String(f[name])} disabled={options.disabled} onChange={(e) => draft.patch({ [name]: e.target.value })} /> : <input value={String(f[name])} disabled={options.disabled} required={options.required} onChange={(e) => draft.patch({ [name]: e.target.value })} />}</label>;
  const a = state.detail?.application;
  const rejected = save?.error?.status === 400 || !a && save?.error?.status === 409;
  const reloadAction = async () => { if (await draft.refreshSaved()) { runtime.abandonDraft(`application-actions:${a!.id}`); setActionsRevision((value) => value + 1); } };
  const canonicalRecovery = canonicalId && <p className="application-notice">Este registro foi unido a um registro canônico. Seu rascunho e a intenção original permanecem aqui para consulta; não serão reaplicados ao alias nem transferidos automaticamente. <Link to={`/vagas/${canonicalId}/editar`}>Abrir edição do registro canônico</Link></p>;
  return <section className="application-editor" aria-label="Cadastro da candidatura">
    <p className="application-notice">Registrar não envia candidatura, currículo ou mensagens. Registre apenas o que aconteceu.</p>
    {canonicalRecovery}
    {state.savedDetail?.application.archivedAt && <p className="application-notice">Registro arquivado. O histórico, as contagens e as ações pendentes permanecem disponíveis.</p>}
    {state.savedDetail !== state.detail && <p className="application-notice">Registro salvo atualizado. Seu rascunho e a intenção original foram mantidos. Ao salvar, confira eventuais diferenças com a versão atual.</p>}
    {state.revising && <p className="application-notice">Revise os dados retidos e prepare uma intenção corrigida. Nada será salvo automaticamente.{state.cycleState === 'not_started' && <> O ciclo ainda não foi iniciado. “Após o marco” exige um ciclo iniciado. <Link to="/revisoes">Iniciar ciclo em Revisões</Link> e então releia os dados antes de preparar novamente sua intenção.</>}</p>}
    {state.refreshing && <p role="status">Relendo registro e acesso…</p>}
    <form onSubmit={(e) => { e.preventDefault(); if (!validDate || canonicalId) return; if (state.revising && a) setConflictOpen(true); else void draft.begin(); }}>
      <fieldset disabled={locked}><legend>{a ? `${a.displayId} · Editar registro` : '01 / Envio'}</legend>
        <div className="application-grid">
          <label>Status do envio<select aria-label="Status do envio" value={f.submissionStatus} disabled={!!a} onChange={(e) => draft.patch({ submissionStatus: e.target.value as Fields['submissionStatus'] })}>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Relação com o ciclo<select aria-label="Relação com o ciclo" value={f.cycleRelation} onChange={(e) => draft.patch({ cycleRelation: e.target.value as Fields['cycleRelation'] })}><option value="unknown">Desconhecida — fora do ciclo</option><option value="before_reset">Anterior ao marco</option><option value="after_reset">Após o marco</option></select></label>
        </div>
        <DateField label="Data do envio" value={f.submittedDate} editorState={f.dateEditor} onEditorChange={(dateEditor) => draft.patch({ dateEditor })} onChange={(submittedDate) => draft.patch({ submittedDate })} onValidityChange={setValidDate} />
        {field('evidence', 'Relato ou evidência', { multiline: true, required: f.submissionStatus === 'confirmado' })}
        <p className="field-hint">Seu relato pode comprovar o envio. Ele não representa verificação independente no portal.</p>
      </fieldset>
      <fieldset disabled={locked}><legend>02 / Oportunidade e trilha</legend><div className="application-grid">
        {field('company', 'Empresa')}{field('title', 'Cargo')}{field('track', 'Trilha')}
        <label>Tipo de oportunidade<select aria-label="Tipo de oportunidade" value={f.kind} onChange={(e) => draft.patch({ kind: e.target.value as Fields['kind'] })}><option value="vaga">Vaga</option><option value="banco_talentos">Banco de talentos</option><option value="pipeline">Pipeline</option><option value="desconhecido">Desconhecido</option></select></label>
        {field('platform', 'Provedor da vaga', { disabled: !!a })}{field('tenant', 'Empresa no provedor (tenant)', { disabled: !!a })}{field('jobCode', 'Código da vaga', { disabled: !!a })}{field('applicationInstance', 'Ocorrência', { required: true })}
      </div><p className="field-hint">Provedor + empresa no provedor + código identificam o anúncio. Trilhas diferentes podem representar candidaturas distintas. Empresa e cargo semelhantes nunca unem registros automaticamente. Uma nova ocorrência exige evidência.</p>
      {a && <p>Identidade do anúncio preservada. Para uma trilha ou ocorrência distinta, <Link to="/vagas/nova">registre outra candidatura com evidência</Link>.</p>}
      {field('links', a ? 'Novos links (um por linha)' : 'Link original e alternativos (um por linha)', { multiline: true })}
      {state.detail?.links.map((link, index) => <SafeLink key={index} value={link.originalUrl} isLocal={link.isLocal} label={`Abrir link registrado ${index + 1}`} />)}
      <div className="application-grid">{field('stack', 'Stack (separada por vírgulas)')}{field('seniority', 'Senioridade')}{field('modality', 'Modalidade')}</div>{field('description', 'Descrição da oportunidade', { multiline: true })}</fieldset>
      <fieldset disabled={locked}><legend>03 / Acompanhamento</legend><div className="application-grid">
        <label>Etapa atual<select aria-label="Etapa atual" value={f.stage} onChange={(e) => draft.patch({ stage: e.target.value as Fields['stage'] })}>{Object.entries(stages).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {field('discoveryChannel', 'Canal de descoberta')}{field('submissionPlatform', 'Plataforma de envio')}
      </div><p className="field-hint">Etapa e envio são independentes. Mudar para entrevista não registra uma entrevista concluída.</p>
      <label>Currículo efetivamente enviado<select aria-label="Currículo efetivamente enviado" multiple value={f.resumeIds} onChange={(e) => draft.patch({ resumeIds: Array.from(e.target.selectedOptions).map((option) => option.value) })}>{refs.data?.map((ref) => <option key={ref.id} value={ref.id}>{ref.label ?? 'Referência sem nome'}</option>)}</select></label><p>{f.resumeIds.length ? `${f.resumeIds.length} referência(s) selecionada(s).` : 'Currículo desconhecido / não informado.'}</p>
      <button type="button" onClick={() => draft.patch({ resumeIds: [] })}>Manter currículo desconhecido</button>
      <ResumeCreator runtime={runtime} draftKey={key} onSelect={(id) => { draft.patch({ resumeIds: [...new Set([...f.resumeIds, id])] }); void refs.refetch(); }} />
      {refs.isError && <p role="alert">Não foi possível carregar as referências de currículo.</p>}
      {field('notes', 'Observações', { multiline: true })}</fieldset>
      {state.error && <p role="alert">{state.error}</p>}
      {state.checking && <p role="status">Conferindo possíveis duplicatas…</p>}
      {!!state.candidates.length && <section className="application-notice" aria-label="Possíveis duplicatas"><h3>Confira antes de registrar</h3><p>Possível duplicata: mesma empresa e cargo. Trilhas e ocorrências distintas podem ser mantidas com evidência. A mesma identidade forte, trilha e ocorrência retorna o registro existente.</p>{state.candidates.map((candidate) => <p key={candidate.id}><Link to={`/vagas/${candidate.id}`}>{candidate.displayId} · {candidate.track ?? 'Trilha não informada'} · {candidate.applicationInstance}</Link></p>)}<button type="button" onClick={() => { if (validDate) void draft.begin(undefined, true); }}>Registrar como candidatura distinta com evidência</button></section>}
      {!canonicalId && (!save || state.revising) && <button type="submit" disabled={!validDate || state.refreshing}>{state.revising ? 'Preparar intenção corrigida' : a ? 'Salvar alterações' : 'Registrar candidatura'}</button>}
      {!canonicalId && save?.status === 'editing' && !state.revising && !state.revisionRequested && <button type="button" onClick={() => { void state.intent!.save(); }}>Salvar intenção revisada</button>}
    </form>
    {save?.status === 'saving' && <p role="status">Salvando…</p>}
    {canonicalId && state.uncertain && save && ['editing', 'error', 'unavailable'].includes(save.status) && <><p>A resposta original foi incerta. Repita a mesma intenção e chave para recuperar o resultado; isso não prepara uma nova edição no alias.</p><button type="button" onClick={() => { void state.intent!.save(); }}>Repetir gravação original</button></>}
    {save?.error && <p role="alert">{!a && save.error.status === 409 ? 'O novo registro foi recusado. Releia o estado atual e revise os dados retidos, incluindo a relação com o ciclo. Nenhum registro existente será substituído.' : save.error.status === 400 ? 'O registro foi recusado. Revise os campos e os links; URLs não podem conter usuário ou senha.' : save.error.message}</p>}
    {!canonicalId && (rejected || state.revisionRequested) && !state.revising && <button type="button" disabled={state.refreshing} onClick={() => { setConflictOpen(false); void draft.requestRevision(); }}>Revisar registro recusado</button>}
    {!canonicalId && save && ['unavailable', 'error'].includes(save.status) && !rejected && !state.revisionRequested && <button type="button" onClick={() => { void state.intent!.save(); }}>Repetir gravação original</button>}
    {!canonicalId && save?.status === 'refresh-required' && !state.revisionRequested && <button type="button" onClick={() => { void state.intent!.refresh(); }}>Reler acesso e manter gravação original</button>}
    {save && a && (state.revising || !state.revisionRequested && ['conflict', 'refresh-required'].includes(save.status)) && <><button type="button" disabled={!validDate} onClick={() => setConflictOpen(true)}>Comparar edição</button>{conflictOpen && <ConflictDialog local={comparable(f)} current={save.current} reapplyBlocked={!!canonicalId} onRefresh={() => state.intent!.refresh()} onReapply={(selected) => { if (!validDate) throw new ApiError(400); draft.reapply(selected); setConflictOpen(false); }} onClose={() => setConflictOpen(false)}>{canonicalRecovery}</ConflictDialog>}</>}
    {save?.status === 'saved' && <div className="application-result" role="status"><p>{save.result?.existing ? 'A mesma identidade, trilha e ocorrência já estão registradas. Nenhum novo envio foi contado; os dados existentes foram preservados.' : 'Registro salvo.'}</p>{save.result?.warnings.map((warning) => <p key={warning.applicationId}>{warning.reason === 'same_company_title' ? 'Possível duplicata: mesma empresa e cargo.' : 'Identidade não resolvida: faltam identificadores fortes.'} <Link to={`/vagas/${warning.applicationId}`}>Conferir registro</Link></p>)}{save.result?.application && <Link to={`/vagas/${save.result.application.id}`}>Abrir registro salvo</Link>}<p><Link to="/vagas">Voltar à lista</Link></p></div>}
    {save?.status === 'saved' && <button type="button" onClick={onReset}>{a ? 'Editar versão atual' : 'Registrar outra candidatura'}</button>}
    {!canonicalId && state.savedDetail && <ApplicationActions key={actionsRevision} runtime={runtime} detail={state.savedDetail} onReload={() => { void reloadAction(); }} />}
  </section>;
}
