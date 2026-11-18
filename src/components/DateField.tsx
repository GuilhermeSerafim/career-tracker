import type { DateValue } from '../../shared/model';
import { dateValueSchema } from '../../shared/model';
import { useEffect, useId, useState } from 'react';
export interface DateFieldProps { label: string; value: DateValue; onChange(value: DateValue): void; onValidityChange?(valid: boolean): void; disabled?: boolean; editorState?: DateEditorState; onEditorChange?(state: DateEditorState): void }
type Precision = DateValue['precision'];
export type DateEditorState = { source: DateValue; precision: Precision; certainty: '' | 'exact' | 'approximate'; text: string };
type Draft = DateEditorState;
const initial = (value: DateValue): Draft => ({ source: value, precision: value.precision, certainty: value.precision === 'unknown' ? '' : value.certainty, text: value.value ?? '' });
const sameDate = (left: DateValue, right: DateValue) => left.precision === right.precision && left.value === right.value &&
  (left.precision === 'unknown' || right.precision !== 'unknown' && left.certainty === right.certainty);
const parse = (draft: Draft) => dateValueSchema.safeParse(draft.precision === 'unknown' ? { precision: 'unknown', value: null } : { precision: draft.precision, certainty: draft.certainty, value: draft.text });
const details = {
  year: { label: 'Ano', example: 'AAAA', error: 'Informe um ano válido com quatro dígitos.' },
  month: { label: 'Mês e ano', example: 'AAAA-MM', error: 'Informe um mês e ano válidos (AAAA-MM).' },
  day: { label: 'Dia, mês e ano', example: 'AAAA-MM-DD', error: 'Informe um dia de calendário válido (AAAA-MM-DD).' },
  instant: { label: 'Data e hora com fuso', example: 'AAAA-MM-DDTHH:mm:ss-03:00', error: 'Informe data, hora e fuso válidos, como 2026-11-16T10:30:00-03:00.' },
};
/** Partial edits stay local unless the caller owns editorState (for tab-memory drafts).
 * Native form validity blocks submission; non-form consumers must also use
 * onValidityChange before saving the last valid value. */
export function DateField({ label, value, onChange, onValidityChange, disabled = false, editorState, onEditorChange }: DateFieldProps) {
  const id = useId();
  const [localDraft, setDraft] = useState(() => initial(value));
  const candidate = editorState ?? localDraft;
  const draft = sameDate(candidate.source, value) ? candidate : initial(value);
  if (!editorState && !sameDate(localDraft.source, value)) setDraft(initial(value));
  const parsed = parse(draft);
  const valid = parsed.success;
  useEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);
  const field = draft.precision === 'unknown' ? null : details[draft.precision];
  const error = parsed.success ? '' : !draft.certainty ? 'Escolha se a data é exata ou aproximada.' : field!.error;
  const update = (next: Draft) => {
    const result = parse(next);
    const editor = { ...next, source: result.success ? result.data : draft.source };
    setDraft(editor);
    if (result.success) onChange(result.data);
    onEditorChange?.(editor);
  };
  const precision = (next: Precision) => {
    // Only discard known detail. Increasing precision never fills absent parts.
    const length = { unknown: 0, year: 4, month: 7, day: 10, instant: 50 };
    const text = parsed.success && length[next] <= length[draft.precision] ? draft.text.slice(0, length[next]) : '';
    update({ ...draft, precision: next, text, certainty: next === 'unknown' ? '' : draft.certainty });
  };
  return <fieldset className="date-field" disabled={disabled} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}>
    <legend>{label}</legend>
    <p id={`${id}-hint`} className="field-hint">Informe apenas o que você sabe. A data informada é independente da data de registro.</p>
    <div className="date-controls">
      <label htmlFor={`${id}-precision`}>Precisão<select aria-label="Precisão" id={`${id}-precision`} value={draft.precision} onChange={(event) => precision(event.target.value as Precision)}>
        <option value="unknown">Desconhecida</option><option value="day">Dia</option><option value="month">Mês</option><option value="year">Ano</option><option value="instant">Instante</option>
      </select></label>
      {field && <>
        <label htmlFor={`${id}-value`}>{field.label}<input id={`${id}-value`} type="text" value={draft.text} placeholder={field.example} required
          aria-invalid={!parsed.success} aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} maxLength={draft.precision === 'instant' ? 50 : 10}
          ref={(element) => { element?.setCustomValidity(error); }} onChange={(event) => update({ ...draft, text: event.target.value })} /></label>
        <label htmlFor={`${id}-certainty`}>Certeza<select aria-label="Certeza" id={`${id}-certainty`} value={draft.certainty} required onChange={(event) => update({ ...draft, certainty: event.target.value as Draft['certainty'] })}>
          <option value="" disabled>Selecione</option><option value="exact">Exata</option><option value="approximate">Aproximada</option>
        </select></label>
      </>}
    </div>
    {error && <p id={`${id}-error`} className="field-error" role="alert">{error}</p>}
  </fieldset>;
}
