import { expect, it } from 'vitest';
import { buildSnapshot, canonicalJson, validateSnapshot } from '../../domain/export';
const owner = '00000000-0000-4000-8000-000000000001';
const time = '2026-11-16T10:20:30.123456+00:00';
const settings = { formatVersion: 1 as const, table: 'owner_settings' as const, data: { id: owner, version: 1, createdAt: time, updatedAt: time, dailyGoal: 5, timezone: 'America/Sao_Paulo' as const } };
it('valida inventário, hashes, IDs duplicados e envelopes sem perder microssegundos', () => {
    const result = buildSnapshot(owner, [settings], time);
    expect(validateSnapshot(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(result.manifest.tables).toHaveLength(20);
    expect(result.entities[0]?.data.createdAt).toBe(time);
    expect(() => validateSnapshot({ ...result, manifest: { ...result.manifest, tables: result.manifest.tables.slice(1) } })).toThrow();
    expect(() => validateSnapshot({ ...result, entities: [{ ...settings, data: { ...settings.data, dailyGoal: 6 } }] })).toThrow();
    expect(() => buildSnapshot(owner, [settings, settings], time)).toThrow();
    expect(() => validateSnapshot({ ...result, __proto__: { polluted: true } })).toThrow();
    expect(() => validateSnapshot(JSON.parse(JSON.stringify(result).replace('"dailyGoal":5', '"dailyGoal":5,"unknown":true')))).toThrow();
});
it('canonicaliza apenas chaves de objetos e mantém __proto__ próprio e arrays', () => {
    expect(canonicalJson(JSON.parse('{"b":[2,1],"__proto__":{"z":1,"a":2},"a":0}'))).toBe('{"__proto__":{"a":2,"z":1},"a":0,"b":[2,1]}');
});
it('recusa referências ausentes, seleções legadas ambíguas e IDs N fora do bigint', () => {
    const base = { id: owner, version: 1, createdAt: time, updatedAt: time };
    expect(() => buildSnapshot(owner, [{ formatVersion: 1, table: 'cycles', data: { ...base, resetDate: { precision: 'unknown', value: null }, resetMarker: null, nextOrder: 1 } }], time)).toThrow();
    expect(() => buildSnapshot(owner, [{ formatVersion: 1, table: 'tasks', data: { ...base, applicationId: owner, contactId: null, title: 't', dueDate: { precision: 'unknown', value: null }, completedDate: { precision: 'unknown', value: null }, status: 'pending' } }], time)).toThrow();
});
it('verifica bytes e hashes internos da origem antes de qualquer restauração', () => {
    const base = { id: owner, version: 1, createdAt: time, updatedAt: time };
    const run = { formatVersion: 1 as const, table: 'import_runs' as const, data: { ...base, importerVersion: 'test', sourceSetHash: 'a'.repeat(64), status: 'completed' as const, pendingIssues: [], unitState: {} } };
    const file = { formatVersion: 1 as const, table: 'source_files' as const, data: { ...base, importRunId: owner, fileName: 'teste.txt', fileHash: 'a'.repeat(64), originalBytesBase64: 'eA==', originalText: 'x' } };
    expect(() => buildSnapshot(owner, [run, file], time)).toThrow();
});
