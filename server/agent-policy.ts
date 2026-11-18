import type { AgentScope } from '../shared/commands';
export type Permission = AgentScope | 'owner';
const writeOperations = new Set(['save_application', 'create_resume_ref', 'confirm_submission', 'update_application', 'record_event', 'correct_event', 'save_task', 'complete_task', 'save_contact', 'archive_application', 'restore_application', 'resolve_duplicate', 'invalidate_submission']);
export function commandPermission(operation: string): Permission {
  if (writeOperations.has(operation)) return 'career:write';
  if (operation === 'close_review' || operation === 'revise_review') return 'career:reviews';
  return 'owner';
}
export function readPermission(url: URL): Permission {
  const path = url.pathname;
  if (path === '/api/v1/exports' || /^\/api\/v1\/reviews\/[^/]+$/.test(path) && url.searchParams.has('format')) return 'career:export';
  if (/^\/api\/v1\/(?:applications(?:\/[^/]+)?|contacts(?:\/[^/]+)?|today|analytics|batches(?:\/[^/]+)?|reviews\/[^/]+|settings|resume-refs|health)$/.test(path)) return 'career:read';
  return 'owner';
}
