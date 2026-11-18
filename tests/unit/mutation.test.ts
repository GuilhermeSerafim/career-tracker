import { describe, expect, it } from 'vitest';
import { canonicalRequestHash } from '../../server/mutation';
import { errorResponse, SafeError } from '../../server/errors';
import { createSafeLogger } from '../../server/logger';

describe('hash canônico de comandos', () => {
  it('ignora ordem de propriedades, inclusive objetos aninhados', () => {
    expect(canonicalRequestHash({ a: 1, z: [{ y: null, x: 'a' }] })).toBe(canonicalRequestHash({ z: [{ x: 'a', y: null }], a: 1 }));
  });
  it('preserva ordem de arrays, strings, null e chaves próprias especiais', () => {
    const values = [null, 'null', [], {}, ['a', 'b'], ['b', 'a'], { x: null }, { x: '' }, JSON.parse('{"__proto__":{"x":1}}')];
    expect(new Set(values.map(canonicalRequestHash)).size).toBe(values.length);
    expect(canonicalRequestHash(JSON.parse('{"__proto__":{"b":2,"a":1},"z":0}'))).toBe(canonicalRequestHash(JSON.parse('{"z":0,"__proto__":{"a":1,"b":2}}')));
  });
  it.each([undefined, NaN, Infinity, new Date(), { x: undefined }, [undefined], new Array(2), Object.create({ x: 1 })])('rejeita valor não JSON sem perda silenciosa: %s', (value) => {
    expect(() => canonicalRequestHash(value)).toThrow(SafeError);
  });
  it('não executa getters/toJSON e limita ciclos, profundidade e tamanho', () => {
    const value = Object.defineProperty({}, 'x', { enumerable: true, get: () => { throw new Error('Getter executado.'); } });
    expect(() => canonicalRequestHash(value)).toThrow(SafeError);
    expect(() => canonicalRequestHash({ toJSON: () => 'segredo' })).toThrow(SafeError);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => canonicalRequestHash(cycle)).toThrow(SafeError);
    expect(() => canonicalRequestHash('a'.repeat(256 * 1024))).toThrow(expect.objectContaining({ status: 413 }));
  });
});

describe('erros e logs seguros', () => {
  const requestId = '00000000-0000-4000-8000-000000000001';
  it('mapeia erro desconhecido para 503 sem mensagem SQL, stack ou dados privados', () => {
    const error = Object.assign(new Error('postgresql://secret:password@private.invalid SQL payload'), { code: '08006' });
    expect(errorResponse(error, requestId)).toEqual({ status: 503, body: { error: { code: 'DATABASE_UNAVAILABLE', message: 'Dados indisponíveis. Tente novamente.', requestId } } });
  });
  it.each([['INVALID_INPUT', 400], ['UNAUTHORIZED', 401], ['FORBIDDEN', 403], ['NOT_FOUND', 404], ['CONFLICT', 409], ['PAYLOAD_TOO_LARGE', 413], ['QUOTA_EXCEEDED', 429], ['DATABASE_UNAVAILABLE', 503]] as const)('preserva status seguro %s', (code, status) => {
    expect(errorResponse(new SafeError(code), requestId)).toMatchObject({ status, body: { error: { code, requestId } } });
  });
  it('preserva o request ID já atribuído ao erro da mutação', () => {
    const error = new SafeError('CONFLICT', { requestId });
    expect(errorResponse(error, '00000000-0000-4000-8000-000000000002').body.error.requestId).toBe(requestId);
  });
  it('escreve somente os quatro campos permitidos, mesmo com Error e payload extras', () => {
    const lines: string[] = [];
    const log = createSafeLogger((line) => lines.push(line));
    const contaminated = { requestId, operation: 'synthetic_edit', status: 409, elapsedMs: 4.6, error: new Error('segredo'), body: 'private_url', token: 'token', query: 'SQL' };
    log(contaminated);
    expect(JSON.parse(lines[0]!)).toEqual({ requestId, operation: 'synthetic_edit', status: 409, elapsedMs: 5 });
    expect(lines[0]).not.toMatch(/segredo|private_url|token|SQL|error/);
  });
});
