import { randomUUID } from 'node:crypto';
import type { syntheticCareerApi } from './synthetic-career';
import { unknownDate } from '../fixtures/career';

export async function seedReview(api: Awaited<ReturnType<typeof syntheticCareerApi>>, initialize = true, count = 30) {
  if (initialize) {
    const start = await api.post({ operation: 'start_cycle', clientId: randomUUID(), resetDate: unknownDate, resetMarker: null });
    if (start.status !== 201) throw new Error('Synthetic cycle rejected');
  }
  const applications = [];
  for (let i = 0; i < count; i++) {
    const result = await api.post({ operation: 'save_application', clientId: randomUUID(), data: { opportunity: { company: `Empresa fictícia ${i}`, title: 'Engenharia', kind: 'vaga', platform: null, tenant: null, jobCode: null, jobKey: null, seniority: null, modality: null, description: null, stack: [], identities: [] }, track: null, applicationInstance: 'initial', submissionStatus: 'confirmado', submittedDate: unknownDate, stage: 'candidatura_enviada', cycleRelation: 'after_reset', discoveryChannel: null, submissionPlatform: null, notes: null, resumeIds: [], links: [] }, evidence: { clientId: randomUUID(), kind: 'relato_usuario', originalText: 'Relato fictício.', source: null, occurredDate: null, privateRef: null, localRef: null } });
    if (result.status !== 201) throw new Error(`Synthetic application rejected: ${result.status}`);
    applications.push(result.json.application);
  }
  return applications;
}
