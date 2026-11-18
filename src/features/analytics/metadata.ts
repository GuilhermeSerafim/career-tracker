import type { AppRuntime } from '../../app/runtime';
import { ApiError } from '../../lib/api';

export interface DisplayMetadata { resumes: Record<string, string>; batches: Record<string, string>; unavailable: boolean }
/** Presentation only. Cache this result in the current owner's runtime/query scope. */
export async function readDisplayMetadata(runtime: AppRuntime, resumeIds: string[], batchIds: string[]): Promise<DisplayMetadata> {
  const owner = runtime.auth.getSnapshot(); const accessPeriod = runtime.getAccessPeriod();
  const resumes: Record<string, string> = {}; const batches: Record<string, string> = {};
  const stillCurrent = () => { const current = runtime.auth.getSnapshot(); return current.status === 'authenticated' && current.generation === owner.generation && current.ownerId === owner.ownerId && runtime.getAccessPeriod() === accessPeriod; };
  const readResumes = async () => {
    if (!resumeIds.length) return;
    const remaining = new Set(resumeIds);
    let cursor: string | null = null;
    do {
      const page: { items: { id: string; label: string | null }[]; nextCursor: string | null } = await runtime.api.read(`/api/v1/resume-refs?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      for (const item of page.items) if (remaining.has(item.id) && (item.label === null || typeof item.label === 'string')) { resumes[item.id] = item.label?.trim() ? item.label : 'CV sem rótulo informado'; remaining.delete(item.id); }
      cursor = page.nextCursor;
    } while (cursor && remaining.size);
  };
  const readBatches = async () => {
    // Bound independent requests while allowing old-cycle references absent from /batches.
    for (let start = 0; start < batchIds.length; start += 4) {
      if (!stillCurrent()) throw new ApiError(0);
      await Promise.allSettled(batchIds.slice(start, start + 4).map(async (id) => {
      const result = await runtime.api.read<{ batch: { id: string; batchNumber: number } }>(`/api/v1/batches/${encodeURIComponent(id)}`);
      if (result.batch.id === id && Number.isSafeInteger(result.batch.batchNumber) && result.batch.batchNumber > 0) batches[id] = `Lote ${result.batch.batchNumber}`;
      }));
    }
  };
  await Promise.allSettled([readResumes(), readBatches()]);
  if (!stillCurrent()) throw new ApiError(0);
  return { resumes, batches, unavailable: resumeIds.some((id) => !Object.hasOwn(resumes, id)) || batchIds.some((id) => !Object.hasOwn(batches, id)) };
}
