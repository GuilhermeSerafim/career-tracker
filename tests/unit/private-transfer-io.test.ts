import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { buildSnapshot, MAX_SNAPSHOT_BYTES } from '../../domain/export';
import { writePrivateExport, readPrivateSnapshot } from '../../scripts/private-transfer-io';
const owner = '00000000-0000-4000-8000-000000000001';
it('publica arquivos completos somente fora do repositório e recusa truncamento/hash incorreto', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'career-private-transfer-'));
    try {
        const snapshot = buildSnapshot(owner, []);
        const files = await writePrivateExport(dir, snapshot, 'both');
        expect(files).toHaveLength(2);
        const file = files.find(file => file.endsWith('.json'))!;
        expect(await readPrivateSnapshot(file)).toEqual(snapshot);
        expect(await readFile(files.find(file => file.endsWith('.csv'))!, 'utf8')).toContain('"status_envio"');
        await expect(writePrivateExport(process.cwd(), snapshot, 'json')).rejects.toThrow();
        await writeFile(file, '{"manifest":');
        await expect(readPrivateSnapshot(file)).rejects.toThrow();
        const sparse = path.join(dir, 'oversized.json');
        const handle = await open(sparse, 'wx');
        await handle.truncate(MAX_SNAPSHOT_BYTES + 1);
        await handle.close();
        await expect(readPrivateSnapshot(sparse)).rejects.toThrow();
    }
    finally {
        await removePrivateTestDirectory(dir);
    }
});
async function removePrivateTestDirectory(directory: string) {
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Destino temporário inválido');
    await rm(directory, { recursive: true, force: true });
}
