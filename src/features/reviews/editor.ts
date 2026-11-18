import type { AppRuntime } from '../../app/runtime';
import { ApiError, createSaveIntent, type CurrentVersion } from '../../lib/api';
import type { Command } from '../../../shared/commands';

/** Only review/settings business drafts. No files, credentials or transfer bodies. */
export function createEditor<F, B>(runtime: AppRuntime, options: {
  fields: F; basis: B; read(): Promise<B>; fieldsFrom(basis: B): F;
  compare(fields: F): CurrentVersion['fields']; versions(basis: B): CurrentVersion['versions'];
  command(fields: F, basis: B): Command; select(local: F, current: F, selected: readonly string[]): F;
  newDraftAfterConflict?(previous: B, current: B): boolean;
}) {
  let state = { fields: options.fields, basis: options.basis, current: null as CurrentVersion | null, intent: null as ReturnType<typeof createSaveIntent<Command, unknown>> | null, needsRead: false, uncertain: false, error: '' };
  let latest = options.basis; let disposed = false; let revision = 0; let restarting = false; let unsubscribeIntent = () => {};
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; listeners.forEach((listener) => listener()); };
  const generation = runtime.auth.getSnapshot().generation;
  const active = () => !disposed && runtime.auth.getSnapshot().generation === generation && runtime.auth.getSnapshot().status === 'authenticated';
  // Only a definitive conflict plus an authorized current read may replace a
  // submitted intention with an incomplete business draft. Uncertain writes
  // keep their exact command/key through the ordinary save-intent path.
  const preparesNewDraft = () => active() && !state.uncertain && !!state.current && state.intent?.getSnapshot().status === 'conflict' && !!options.newDraftAfterConflict?.(state.basis, latest);
  const canReplayOriginal = () => active() && state.uncertain && !!state.current && !!state.intent && ['editing', 'unavailable', 'error'].includes(state.intent.getSnapshot().status);
  const performSave = async (intent: NonNullable<typeof state.intent>) => {
    const wasUncertain = state.uncertain;
    await intent.save();
    if (disposed || state.intent !== intent) return;
    const status = intent.getSnapshot().status;
    publish({ uncertain: status === 'saved' || status === 'conflict' ? false : status === 'forbidden' ? wasUncertain : true, ...(status === 'saved' ? { needsRead: false } : {}) });
  };
  const read = async () => {
    const stamp = revision; const basis = await options.read();
    if (!active() || stamp !== revision) throw new ApiError(0);
    latest = basis;
    return { versions: options.versions(basis), fields: options.compare(options.fieldsFrom(basis)) };
  };
  const attach = (intent: NonNullable<typeof state.intent>) => {
    unsubscribeIntent(); unsubscribeIntent = intent.subscribe(() => publish({ current: intent.getSnapshot().current }));
    publish({ intent });
  };
  const unsubscribeAuth = runtime.auth.subscribe(() => {
    if (runtime.auth.getSnapshot().status !== 'authenticated') { revision++; publish({ needsRead: true, current: null }); }
  });
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    preparesNewDraft,
    canReplayOriginal,
    replayOriginal: async () => { if (canReplayOriginal()) await performSave(state.intent!); },
    edit: (patch: Partial<F>) => { if (!state.intent && active()) publish({ fields: { ...state.fields, ...patch }, error: '' }); },
    save: async () => {
      if (!active() || state.needsRead && !state.intent) return;
      try {
        if (!state.intent) attach(createSaveIntent({ auth: runtime.auth, api: runtime.api, draft: options.command(state.fields, state.basis), readCurrent: read }));
        await performSave(state.intent!);
      } catch { publish({ error: 'Confira os campos e os limites antes de salvar. Sua edição foi mantida.' }); }
    },
    refresh: async () => {
      // A failed comparison read must remain reachable after the dialog closes.
      // Only explicit reapply (or a fresh draft transition) clears this gate.
      publish({ needsRead: true, current: null });
      if (state.intent) return state.intent.refresh();
      try { const current = await read(); publish({ current }); return { status: 'ready' as const, current }; }
      catch (error) { return { status: 'error' as const, error: error instanceof ApiError ? error : new ApiError(503) }; }
    },
    reapply: (selected: readonly string[]) => {
      if (!active() || !state.current) throw new ApiError(409);
      const fields = options.select(state.fields, options.fieldsFrom(latest), selected);
      if (preparesNewDraft()) {
        unsubscribeIntent(); state.intent!.dispose();
        publish({ fields, basis: latest, current: null, intent: null, needsRead: false, uncertain: false, error: '' });
        return 'draft' as const;
      }
      const command = options.command(fields, latest);
      if (state.intent) state.intent.reapply(command);
      else attach(createSaveIntent({ auth: runtime.auth, api: runtime.api, draft: command, readCurrent: read }));
      publish({ fields, basis: latest, needsRead: false, uncertain: false, error: '' });
      return 'intent' as const;
    },
    restart: async () => {
      if (!active() || restarting || state.intent?.getSnapshot().status !== 'saved') return;
      restarting = true;
      try {
        await read();
        unsubscribeIntent(); state.intent?.dispose();
        publish({ fields: options.fieldsFrom(latest), basis: latest, current: null, intent: null, needsRead: false, uncertain: false, error: '' });
      } catch { if (active()) publish({ error: 'Não foi possível reler para uma nova edição. Tente novamente.' }); }
      finally { restarting = false; }
    },
    dispose: () => { disposed = true; revision++; unsubscribeAuth(); unsubscribeIntent(); state.intent?.dispose(); state = { ...state, fields: null as F, basis: null as B, current: null, intent: null }; listeners.clear(); },
  };
}
export type Editor<F, B> = ReturnType<typeof createEditor<F, B>>;
