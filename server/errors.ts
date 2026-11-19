const errors = {
  FIXTURE_CHANGED: [409, 'O estado da verificação técnica diverge da autorização.'],
  CYCLE_NOT_STARTED: [409, 'Inicie o ciclo antes de alocar envios após o reinício.'],
  CYCLE_CONFIGURATION: [409, 'Defina explicitamente o ciclo atual nos dados importados.'],
  INVALID_INPUT: [400, 'Dados inválidos. Confira os campos informados.'],
  UNAUTHORIZED: [401, 'Sessão inválida. Entre novamente.'],
  FORBIDDEN: [403, 'Acesso não autorizado.'],
  NOT_FOUND: [404, 'Registro não encontrado.'],
  METHOD_NOT_ALLOWED: [405, 'Método não permitido para esta rota.'],
  CONFLICT: [409, 'O registro foi alterado. Confira a versão atual e tente novamente.'],
  IDEMPOTENCY_CONFLICT: [409, 'Esta chave já foi usada com outros dados.'],
  PAYLOAD_TOO_LARGE: [413, 'Os dados excedem o limite permitido.'],
  EXPORT_TOO_LARGE: [413, 'A exportação completa excede o limite HTTP de 4.000.000 bytes. Use a exportação local privada.'],
  QUOTA_EXCEEDED: [429, 'Limite de solicitações atingido. Tente novamente mais tarde.'],
  AUTH_UNAVAILABLE: [503, 'Autenticação indisponível. Tente novamente.'],
  DATABASE_UNAVAILABLE: [503, 'Dados indisponíveis. Tente novamente.'],
  MAINTENANCE: [503, 'Sistema em manutenção. Tente novamente.'],
  NOT_CONFIGURED: [503, 'Sistema indisponível. Verifique a configuração.'],
} as const;

export interface ConflictDetails { currentVersion: number; changedFields: string[] }
export class SafeError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly details?: ConflictDetails;
  constructor(readonly code: keyof typeof errors, options: { requestId?: string; details?: ConflictDetails } = {}) {
    super(errors[code][1]);
    this.name = 'SafeError';
    this.status = errors[code][0];
    this.requestId = options.requestId;
    if (code === 'CONFLICT' && options.details) this.details = { currentVersion: options.details.currentVersion, changedFields: [...options.details.changedFields] };
  }
}

export function safeError(error: unknown, requestId: string): SafeError {
  if (error instanceof SafeError) return new SafeError(error.code, { requestId, details: error.details });
  // Não copiar mensagem, stack, detail, query ou qualquer propriedade do driver.
  return new SafeError('DATABASE_UNAVAILABLE', { requestId });
}

export function errorResponse(error: unknown, fallbackRequestId: string) {
  const requestId = error instanceof SafeError && error.requestId ? error.requestId : fallbackRequestId;
  const safe = safeError(error, requestId);
  return { status: safe.status, body: { error: { code: safe.code, message: safe.message, requestId,
    ...(safe.details ? { details: safe.details } : {}),
  } } };
}
