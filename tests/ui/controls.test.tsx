// @vitest-environment jsdom
import '../../src/app/validation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import type { DateValue } from '../../shared/model';
import { DateField } from '../../src/components/DateField';
import { SafeLink } from '../../src/components/SafeLink';

afterEach(cleanup);
function Editor({ initial = { precision: 'unknown', value: null } as DateValue }) {
  const [value, setValue] = useState(initial);
  return <form aria-label="Edição"><DateField label="Data do acontecimento" value={value} onChange={setValue} /><output>{JSON.stringify(value)}</output></form>;
}
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('date precision editor', () => {
  it('retains unknown and never creates today or unknown components when precision increases', async () => {
    render(<Editor />);
    expect(screen.getByLabelText('Precisão')).toHaveValue('unknown');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Precisão'), 'year');
    expect(screen.getByLabelText('Ano')).toHaveValue('');
    expect(screen.getByLabelText('Certeza')).toHaveValue('');
    expect(screen.getByRole('form')).toBeInvalid();
    change('Ano', '2024'); change('Certeza', 'approximate');
    expect(screen.getByRole('status')).toHaveTextContent('"precision":"year","certainty":"approximate","value":"2024"');
    change('Precisão', 'month');
    expect(screen.getByLabelText('Mês e ano')).toHaveValue('');
    expect(screen.getByRole('form')).toBeInvalid();
    change('Precisão', 'unknown');
    expect(screen.getByRole('form')).toBeValid();
    expect(screen.getByRole('status')).toHaveTextContent('"precision":"unknown","value":null');
  });
  it('validates leap days and certainty without publishing invalid dates', () => {
    render(<Editor initial={{ precision: 'day', certainty: 'exact', value: '2024-02-29' }} />);
    change('Dia, mês e ano', '2023-02-29');
    expect(screen.getByRole('alert')).toHaveTextContent('dia de calendário válido');
    expect(screen.getByRole('form')).toBeInvalid();
    expect(screen.getByRole('status')).toHaveTextContent('2024-02-29');
    change('Dia, mês e ano', '2023-02-28'); change('Certeza', 'approximate');
    expect(screen.getByRole('form')).toBeValid();
    expect(screen.getByRole('status')).toHaveTextContent('"certainty":"approximate","value":"2023-02-28"');
    change('Precisão', 'month');
    expect(screen.getByLabelText('Mês e ano')).toHaveValue('2023-02');
    expect(screen.getByRole('status')).toHaveTextContent('"precision":"month"');
  });
  it.each([['year', 'Ano', '0000', '2026'], ['month', 'Mês e ano', '2026-13', '2026-11'],
    ['instant', 'Data e hora com fuso', '2026-11-16T10:30:00', '2026-11-16T10:30:00-03:00']])('validates %s through DateValue and requires timezone for instants', (precision, label, invalid, valid) => {
    render(<Editor />);
    change('Precisão', precision); change('Certeza', 'exact'); change(label, invalid);
    expect(screen.getByRole('form')).toBeInvalid();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    change(label, valid);
    expect(screen.getByRole('form')).toBeValid();
    expect(screen.getByRole('status')).toHaveTextContent(valid);
  });
  it('accepts external value replacement and exposes incomplete validity to non-form consumers', () => {
    const onChange = vi.fn(); const onValidityChange = vi.fn();
    const props = { label: 'Data', onChange, onValidityChange };
    const view = render(<DateField {...props} value={{ precision: 'year', certainty: 'exact', value: '2025' }} />);
    change('Ano', '20'); expect(onValidityChange).toHaveBeenLastCalledWith(false);
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(<DateField {...props} value={{ precision: 'unknown', value: null }} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });
  it.each(['2023-02-', '2023-02-29'])('keeps %s blocked through equal parent values with reordered keys', async (text) => {
    const onChange = vi.fn(); const onValidityChange = vi.fn(); const saved = vi.fn();
    const initial: DateValue = { precision: 'day', certainty: 'exact', value: '2024-02-29' };
    const form = (value: DateValue) => <form aria-label="Data em edição" onSubmit={(event) => { event.preventDefault(); saved(); }}>
      <DateField label="Data" value={value} onChange={onChange} onValidityChange={onValidityChange} /><button type="submit">Salvar</button>
    </form>;
    const view = render(form(initial));
    change('Dia, mês e ano', text);
    view.rerender(form({ ...initial }));
    expect(screen.getByRole('textbox')).toHaveValue(text);
    view.rerender(form({ value: '2024-02-29', certainty: 'exact', precision: 'day' }));
    expect(screen.getByRole('textbox')).toHaveValue(text);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('form')).toBeInvalid();
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(saved).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
    view.rerender(form({ value: '2025-03-01', precision: 'day', certainty: 'approximate' }));
    expect(screen.getByRole('textbox')).toHaveValue('2025-03-01');
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('form')).toBeValid();
    view.rerender(form({ value: null, precision: 'unknown' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('form')).toBeValid();
  });
});

describe('safe reference rendering', () => {
  it('uses a token-safe label and external privacy protections', () => {
    const url = 'https://example.invalid/?token=synthetic-private';
    render(<SafeLink value={url} />);
    const link = screen.getByRole('link', { name: 'Abrir referência externa (nova aba)' });
    expect(link).toHaveAttribute('href', url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(document.body.textContent).not.toContain('synthetic-private');
    expect(link).not.toHaveAttribute('title');
  });
  it('renders local paths as labeled text and escaped imported/Markdown labels without HTML interpretation', () => {
    const label = '<script>alert(1)</script> [open](javascript:alert(1))';
    render(<><SafeLink value={'C:\\Docs\\private.txt'} isLocal label={label} /><SafeLink value="javascript:alert(1)" label={label} /></>);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getAllByText(label)).toHaveLength(2);
    expect(screen.getByText(/Arquivo neste computador/)).toBeInTheDocument();
    expect(screen.getByText('Referência indisponível.')).toBeInTheDocument();
  });
});
