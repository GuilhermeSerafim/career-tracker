import { randomUUID } from 'node:crypto';
import type { Command } from '../../shared/commands';
import type { DateValue } from '../../shared/model';
import type { syntheticCareerApi } from './synthetic-career';
import { day, unknownDate } from '../fixtures/career';

/** Fictional business setup always enters through the real command router. */
export async function seedToday(fixture: Awaited<ReturnType<typeof syntheticCareerApi>>) {
  const post = async (command: Command) => {
    const response = await fixture.post(command);
    if (response.status !== 200 && response.status !== 201) throw new Error(`Synthetic command rejected: ${command.operation} (${response.status}).`);
    return response.json;
  };
  await post({ operation: 'start_cycle', clientId: randomUUID(), resetDate: day('2026-11-01'), resetMarker: 'Synthetic cycle' });
  const save = async (company: string, submittedDate: DateValue, cycleRelation: 'before_reset' | 'after_reset' | 'unknown') => (await post({ operation: 'save_application', clientId: randomUUID(), data: { opportunity: { company, title: 'Engenharia fictícia', kind: 'vaga', platform: null, tenant: null, jobCode: null, jobKey: null, seniority: null, modality: null, description: null, stack: [], identities: [] }, track: null, applicationInstance: 'initial', submissionStatus: 'confirmado', submittedDate, stage: 'candidatura_enviada', cycleRelation, discoveryChannel: null, submissionPlatform: null, notes: null, resumeIds: [], links: [] }, evidence: { clientId: randomUUID(), kind: 'relato_usuario', originalText: 'Relato inteiramente fictício.', source: null, occurredDate: submittedDate, privateRef: null, localRef: null } })).application;
  let current = await save('Empresa de hoje', day('2026-11-15'), 'after_reset');
  await save('Empresa de ontem', day('2026-11-14'), 'after_reset');
  await save('Empresa sem data', unknownDate, 'unknown');
  await save('Empresa com mês conhecido', { precision: 'month', certainty: 'exact', value: '2026-11' }, 'unknown');
  const previous = await save('Empresa do processo anterior', day('2026-10-01'), 'before_reset');
  await post({ operation: 'record_event', clientId: randomUUID(), application: { id: previous.id, expectedVersion: previous.version }, data: { kind: 'entrevista', state: 'concluido', occurredDate: day('2026-10-02'), resultText: 'Conversa anterior concluída.', scoreValue: null, scoreUnit: null, sourceText: null, evidence: null } });
  const contact = (await post({ operation: 'save_contact', target: { clientId: randomUUID() }, data: { name: null, notes: 'Contato fictício sem nome informado.', links: [{ originalUrl: 'https://example.test/conversa?token=fictional-only', comparisonUrl: null, kind: 'conversa', isLocal: false, isPrivate: true }] } })).contact;
  // Deliberately inserted out of deadline order; /today must return overdue first.
  for (const [title, dueDate] of [
    ['Revisar anotações', day('2026-11-18')],
    ['Organizar dúvidas', unknownDate],
    ['Preparar entrevista', day('2026-11-15')],
    ['Retomar conversa', day('2026-11-14')],
  ] as const) {
    const saved = await post({ operation: 'save_task', target: { clientId: randomUUID() }, parents: { application: { id: current.id, expectedVersion: current.version }, contact: null }, data: { title, dueDate } });
    current = { ...current, version: saved.parents.application.version };
  }
  await post({ operation: 'save_task', target: { clientId: randomUUID() }, parents: { application: null, contact: { id: contact.id, expectedVersion: contact.version } }, data: { title: 'Retomar conversa independente', dueDate: unknownDate } });
  return { applicationId: current.id, contactId: contact.id };
}
