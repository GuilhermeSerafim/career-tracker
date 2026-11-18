import type { TransferEntity } from '../shared/transfer';

type Review = Extract<TransferEntity, { table: 'review_versions' }>['data'];
// Treat all stored prose as text. Never emit user HTML, images or active links.
const escape = (value: unknown) => String(value ?? 'Não informado').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_[\]{}()#+.!|~-])/g, '\\$1');
const privateBlock = (value: unknown) => JSON.stringify(value ?? null, null, 2).split('\n').map((line) => `    ${line}`).join('\n');
export function reviewMarkdown(review: Review): string {
  const snapshot = review.snapshot;
  return [
    '# Revisão privada', `Versão: ${review.versionNumber} · Tipo: ${escape(review.type)}`,
    `Fechamento: ${escape(review.closedAt)} · Registrada em: ${escape(review.createdAt)}`,
    `Predecessora: ${escape(review.predecessorId)}`, `Motivo: ${escape(review.reason)}`,
    '## Balanço congelado', ...Object.entries(snapshot.metrics).map(([key, metric]) => `- ${escape(key)}: ${metric.numerator}/${metric.denominator} (${metric.ratio === null ? 'sem dados' : `${(metric.ratio * 100).toFixed(1)}%`})`),
    '## População capturada', ...review.populationIds.map((id) => `- ${escape(id)}`),
    '## Elegíveis nesta versão', ...(snapshot.eligiblePopulationIds ?? []).map((id) => `- ${escape(id)}`),
    '## Análise', escape(review.narrative), '## Próximos passos', ...review.decisions.map((decision) => `- ${escape(decision)}`),
    '## Cobertura', privateBlock(snapshot.coverage),
    '## Resultados históricos externos', privateBlock({ applicationIds: snapshot.externalResultApplicationIds, eventIds: snapshot.externalResultEventIds }),
    '## Snapshot e proveniência privados', privateBlock({ snapshot, calculationVersion: review.calculationVersion, evidenceId: review.evidenceId, originalMarkdown: review.originalMarkdown, importProvenance: review.importProvenance }),
  ].join('\n\n') + '\n';
}
