import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import { csvFileNameSchema, MAX_CSV_UPLOAD_BYTES, MAX_CSV_UPLOAD_ROWS, type CsvPreview, type CsvUpload } from '../../../shared/csv-upload';
import type { AppRuntime } from '../../app/runtime';
import { ApiError } from '../../lib/api';
import { displayDate } from '../today/today-data';
import { statuses } from './application-data';
import './applications.css';
import { HistoricalImportPanel } from './HistoricalImportPanel';

const rowLabels: Record<CsvPreview['rows'][number]['status'], string> = {
  eligible: 'Pronta para importar', unchanged: 'Já importada', duplicate: 'Possível duplicata',
  conflict: 'Conflito', blocked: 'Requer correção',
};
const issueLabels: Record<string, string> = {
  invalid_header: 'As colunas precisam seguir o cabeçalho do CSV legado.',
  invalid_csv: 'Confira as vírgulas, aspas e a quantidade de campos de cada registro.',
  invalid_utf8: 'Salve o arquivo com codificação UTF-8.',
  invalid_text: 'O arquivo contém caracteres nulos. Exporte novamente como CSV UTF-8.',
  empty_csv: 'O CSV precisa ter ao menos um registro além do cabeçalho.',
  source_too_large: 'O arquivo ultrapassa o tamanho permitido.',
  row_limit: `O arquivo ultrapassa o limite de ${MAX_CSV_UPLOAD_ROWS} registros. Divida o CSV e mantenha o cabeçalho em cada parte.`,
  record_too_large: 'Um registro ultrapassa o limite de texto. Confira o comprimento dos campos.',
  invalid_date: 'Use uma data no formato AAAA-MM-DD ou deixe o campo vazio.',
  invalid_status: 'Use confirmado, nao_confirmado ou nao_enviado para o status de envio.',
  invalid_id: 'O ID legado deve começar com V seguido de números.',
  duplicate_id: 'O mesmo ID aparece em outro registro do arquivo. Confira os originais.',
  invalid_order: 'Use um inteiro positivo para a ordem do ciclo ou deixe o campo vazio.',
  duplicate_order: 'A mesma ordem de ciclo aparece em outro registro do arquivo.',
  possible_duplicate: 'Os dados da vaga coincidem com outro registro. Confira se são candidaturas distintas.',
  source_changed: 'A fonte mudou desde a importação anterior.',
  application_changed: 'A candidatura foi editada desde a importação anterior.',
  conflict: 'A fonte e a candidatura mudaram desde a importação anterior.',
  existing_id: 'O ID já pertence a uma candidatura sem base de importação comparável.',
  existing_order: 'A ordem de ciclo já pertence a outra candidatura.',
  legacy_url_review: 'Um endereço web exige revisão. Confira o link no CSV antes de importar este registro.',
  projection_limits: 'O registro excede os limites de identificação ou de referências aceitos no cadastro.',
  dangerous_reference: 'Referência incompatível com o cadastro. O texto original é preservado na origem arquivada.',
  unknown_reference: 'Formato de referência desconhecido. O texto original é preservado na origem arquivada.',
  unprojected_reference: 'Algumas referências só cabem no texto original arquivado.',
  unprojected_source_attribution: 'A atribuição de origem só cabe no texto original arquivado.',
};
const fieldLabels: Record<string, string> = {
  id: 'ID', empresa: 'empresa', cargo: 'cargo', plataforma: 'plataforma', codigo_vaga: 'código da vaga',
  chave_vaga: 'chave da vaga', url_original: 'link original', links_alternativos: 'links alternativos',
  status_envio: 'status do envio', data_envio: 'data de envio', evidencia_envio: 'evidência do envio',
  cv_enviado: 'currículo', etapa: 'etapa', ordem_ciclo: 'ordem do ciclo', fonte: 'fonte',
  observacoes: 'observações', registrado_em: 'data de registro',
};
const pageSize = 25;

function encodeUpload(file: File): Promise<CsvUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reader.onabort = () => reject(new ApiError(400));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      const chunks: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
      resolve({ fileName: file.name, bytesBase64: btoa(chunks.join('')) });
    };
    reader.readAsArrayBuffer(file);
  });
}

export function CsvImportPage({ runtime }: { runtime: AppRuntime }) {
  const transfer = useSyncExternalStore(runtime.transfers.subscribe, runtime.transfers.getSnapshot);
  const pendingCsv = transfer.pendingImport?.unit.unit === 'csv';
  const pendingHistorical = !!transfer.pendingImport && !pendingCsv;
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ data: CsvPreview; upload: CsvUpload } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const busy = checking || transfer.importStatus === 'saving';
  const receipt = !file && !pendingCsv && !error ? transfer.csvReceipt : null;

  const check = async () => {
    if (!file || checking || transfer.pendingImport) return;
    setPreview(null);
    setConfirmed(false);
    setError('');
    if (file.size > MAX_CSV_UPLOAD_BYTES) { setError('O arquivo ultrapassa 1 MiB. Divida o CSV e mantenha o cabeçalho em cada parte.'); return; }
    if (!file.size || !csvFileNameSchema.safeParse(file.name).success) { setError('Selecione um arquivo .csv com conteúdo e um nome válido.'); return; }
    setChecking(true);
    try {
      const upload = await encodeUpload(file);
      if (!mounted.current) return;
      const data = await runtime.transfers.previewCsvUpload(upload);
      if (mounted.current) setPreview({ data, upload });
    } catch (error) {
      if (mounted.current) setError(error instanceof ApiError && [400, 413].includes(error.status)
        ? 'Arquivo recusado. Confira o formato CSV, a codificação UTF-8 e os limites de envio.'
        : 'Prévia indisponível. Confira a conexão e tente conferir o arquivo novamente.');
    } finally { if (mounted.current) setChecking(false); }
  };

  const apply = async (retry: boolean) => {
    const confirmation = preview?.data.confirmation;
    if (busy || (retry ? !pendingCsv : !preview || !confirmation || !confirmed || !!transfer.pendingImport)) return;
    setError('');
    try {
      await (retry ? runtime.transfers.retryImport() : runtime.transfers.confirmCsvUpload({ ...preview!.upload, confirmation: confirmation! }));
      void runtime.query.invalidateQueries({ predicate: ({ queryKey }) => ['applications', 'today', 'analytics'].includes(String(queryKey[0])) });
      if (mounted.current) {
        setPreview(null);
        setFile(null);
        setConfirmed(false);
        if (input.current) input.current.value = '';
      }
    } catch (error) {
      if (!mounted.current) return;
      const status = error instanceof ApiError ? error.status : 503;
      if ([400, 403, 409, 413].includes(status)) {
        setPreview(null);
        setConfirmed(false);
        setError(status === 409 ? 'Os dados mudaram desde a conferência. Gere uma nova prévia e confira a seleção.'
          : status === 403 ? 'A sessão atual não tem permissão para importar. Confira o acesso da conta.'
          : 'A confirmação foi recusada. Confira o arquivo e gere uma nova prévia.');
      } else if (status === 429) {
        setError('Limite de solicitações atingido. Aguarde um minuto e repita a confirmação.');
      }
    }
  };

  return <div className="csv-import">
    <section className="page-intro">
      <Link className="text-action csv-back" to="/vagas">Voltar para Vagas</Link>
      <h1 tabIndex={-1}>Importar candidaturas</h1>
      <p>Confira o CSV legado antes de inserir novas candidaturas no seu espaço privado.</p>
    </section>

    <section className="csv-panel" aria-labelledby="csv-file-title">
      <h2 id="csv-file-title">Arquivo de origem</h2>
      <p id="csv-format">Use um CSV no formato legado, em UTF-8, com até 1 MiB e {MAX_CSV_UPLOAD_ROWS} registros.</p>
      <p>A importação preserva IDs, ordem registrada, evidências e referências. Datas vazias ficam desconhecidas. Vínculos com o ciclo atual e decisões sobre etapas, lotes ou revisões históricas exigem análise própria.</p>
      <form onSubmit={(event) => { event.preventDefault(); void check(); }}>
        <label htmlFor="csv-source">Arquivo CSV</label>
        <div className="csv-file-controls">
          <input id="csv-source" type="file" ref={input} accept=".csv,text/csv" aria-describedby="csv-format" disabled={busy || !!transfer.pendingImport} onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setPreview(null); setConfirmed(false); setError('');
          }} />
          <button type="submit" disabled={busy || !file || !!transfer.pendingImport}>Conferir arquivo</button>
        </div>
      </form>
      {checking && <p role="status">Conferindo arquivo…</p>}
      {error && <p role="alert" className="csv-feedback">{error}</p>}
      {pendingHistorical && <p>Há uma unidade histórica pendente. <Link to="/configuracoes">Retomar em Configurações</Link>.</p>}
    </section>

    <HistoricalImportPanel runtime={runtime} disabled={busy || !!transfer.pendingImport} />
    {pendingCsv && <section className="csv-panel" aria-labelledby="csv-pending-title">
      <h2 id="csv-pending-title">Confirmação do CSV</h2>
      <p role="status">{busy ? 'Aguardando confirmação do servidor…' : 'Resultado ainda não confirmado. Repita o pedido original para recuperar o resultado com segurança.'}</p>
      <p>O pedido fica na memória desta aba. Se você recarregar ou fechar a aba, selecione o arquivo novamente para conferir o que foi importado.</p>
      <button type="button" disabled={busy} onClick={() => { void apply(true); }}>Repetir confirmação</button>
    </section>}

    {receipt && <section className="csv-panel" aria-labelledby="csv-receipt-title">
      <h2 id="csv-receipt-title">Importação concluída</h2>
      <div role="status"><Totals entries={[[receipt.imported, 'Importadas'], [receipt.unchanged, 'Já importadas'], [receipt.review, 'Para revisar']]} /></div>
      <Link to="/vagas" className="text-action">Abrir lista de candidaturas</Link>
    </section>}

    {preview && <section className="csv-panel" aria-labelledby="csv-preview-title">
      <h2 id="csv-preview-title">Prévia do arquivo</h2>
      <div role="status"><Totals entries={[[preview.data.totals.rows, 'Registros'], [preview.data.totals.eligible, 'Prontas para importar'], [preview.data.totals.unchanged, 'Já importadas'], [preview.data.totals.review, 'Para revisar']]} /></div>
      {preview.data.issues.length > 0 && <div role="alert" className="csv-feedback"><h3>Corrija o arquivo para continuar</h3><ul>{preview.data.issues.map(({ code, row, column }, index) =>
        <li key={`${code}:${index}`}>{row ? `Registro ${row}${column ? ` (${fieldLabels[column] ?? 'campo'})` : ''}. ` : ''}{issueLabels[code] ?? 'Confira o formato deste registro.'}</li>,
      )}</ul></div>}
      <PreviewRows data={preview.data} />
      {preview.data.confirmation && !pendingCsv && <div className="csv-approval">
        <p>Confira as linhas prontas. Linhas em revisão ficam fora da confirmação.</p>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Conferi a prévia e autorizo a importação das linhas prontas</label>
        <button type="button" disabled={!confirmed || busy || pendingHistorical} onClick={() => { void apply(false); }}>
          Importar {preview.data.totals.eligible} {preview.data.totals.eligible === 1 ? 'linha' : 'linhas'}
        </button>
      </div>}
      {!preview.data.confirmation && !preview.data.blocked && <p>Nenhuma linha pronta para importar. Confira as situações indicadas abaixo de cada registro.</p>}
    </section>}
  </div>;
}

function Totals({ entries }: { entries: [number, string][] }) {
  return <dl className="csv-totals">{entries.map(([number, label]) => <div key={label}><dt>{label}</dt><dd>{number}</dd></div>)}</dl>;
}

function PreviewRows({ data }: { data: CsvPreview }) {
  const [page, setPage] = useState(0);
  if (!data.rows.length) return null;
  const totalPages = Math.ceil(data.rows.length / pageSize);
  return <>
    <h3>Registros do CSV</h3>
    <ol className="csv-records" role="list" start={page * pageSize + 2}>{data.rows.slice(page * pageSize, (page + 1) * pageSize).map((row) =>
      <li key={row.number}>
        <div className="csv-record-heading">
          <div><p className="csv-record-number">Registro {row.number}{row.legacyId && ` · ${row.legacyId}`}</p><h4>{row.company || 'Não informada'}</h4><p>{row.title || 'Cargo não informado'}</p></div>
          <strong className={`csv-row-status csv-row-${row.status}`}>{rowLabels[row.status]}</strong>
        </div>
        <p>{row.submissionStatus ? statuses[row.submissionStatus] : 'Status de envio inválido'} · {displayDate(row.submittedDate, 'America/Sao_Paulo')}{row.cycleOrder && ` · Ordem ${row.cycleOrder}`}</p>
        {row.missing.length > 0 && <p><strong>Campos vazios</strong> {row.missing.map((column) => fieldLabels[column] ?? column).join(', ')}.</p>}
        {row.issues.some((issue) => issueLabels[issue]) && <ul className="csv-row-issues">{row.issues.filter((issue) => issueLabels[issue]).map((issue) => <li key={issue}>{issueLabels[issue]}</li>)}</ul>}
      </li>,
    )}</ol>
    {totalPages > 1 && <nav className="application-pagination" aria-label="Páginas da prévia">
      <button type="button" disabled={!page} onClick={() => setPage(page - 1)}>Página anterior</button>
      <span role="status">Página {page + 1} de {totalPages}</span>
      <button type="button" disabled={page + 1 >= totalPages} onClick={() => setPage(page + 1)}>Próxima página</button>
    </nav>}
  </>;
}
