import type { z } from 'zod';
import type { eventFields } from './model';
import type { reviewSnapshotSchema } from './transfer';

/** Fields read by the browser after the complete server-side package validation. */
type EventFields = { [K in keyof typeof eventFields]: z.infer<typeof eventFields[K]> };
export interface HistoricalPackageView {
  ownerId: string;
  operationId: string;
  capturedAt: string;
  sourceSetHash: string;
  prepare: { manifest: { parsed: { sourceHash: string; rows: { legacyId: string; raw: string; rawRowHash: string }[] } } };
  applications: { legacyId: string; historicalEvents?: (EventFields & { clientId: string })[] }[];
  review: {
    members: { legacyId: string; capturedOrder: number }[];
    closedAt: string | null;
    snapshot: Pick<z.infer<typeof reviewSnapshotSchema>, 'schemaVersion' | 'period' | 'eventIds' | 'metrics'>;
  };
  complete: { reviewRequired: true };
}
