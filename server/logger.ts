export interface RequestLog { requestId: string; operation: string; status: number; elapsedMs: number }

/** Projeção explícita: o sink nunca recebe Error, corpo, URL ou contexto de auth. */
export function createSafeLogger(sink: (line: string) => void = (line) => console.info(line)) {
  return (entry: RequestLog): void => {
    const requestId = /^[0-9a-f-]{36}$/i.test(entry.requestId) ? entry.requestId : 'invalid';
    const operation = /^[a-z][a-z0-9_]{0,99}$/.test(entry.operation) ? entry.operation : 'invalid';
    const status = Number.isInteger(entry.status) && entry.status >= 100 && entry.status <= 599 ? entry.status : 503;
    const elapsedMs = Number.isFinite(entry.elapsedMs) ? Math.max(0, Math.round(entry.elapsedMs)) : 0;
    // Falha do transporte de logs não pode transformar COMMIT confirmado em erro.
    try { sink(JSON.stringify({ requestId, operation, status, elapsedMs })); } catch { /* Sem fallback que exponha o erro. */ }
  };
}
