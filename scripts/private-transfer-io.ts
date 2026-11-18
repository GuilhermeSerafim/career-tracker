import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, MAX_SNAPSHOT_BYTES, snapshotCsv, TransferError, validateSnapshot, type Snapshot } from '../domain/export';
const project = fileURLToPath(new URL('../', import.meta.url));
const within = (root: string, target: string) => { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
async function outsideRepository(directory: string): Promise<string> {
    const target = await realpath(directory);
    const worktree = await realpath(project);
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const repository = await realpath(path.dirname(path.resolve(worktree, common)));
    if (within(worktree, target) || within(repository, target))
        throw new TransferError();
    return target;
}
/** Nomes novos; publicação atômica por hardlink exclusivo nunca substitui um arquivo. */
export async function writePrivateExport(directory: string, input: Snapshot, format: 'json' | 'csv' | 'both'): Promise<string[]> {
    try {
        if (!['json', 'csv', 'both'].includes(format))
            throw new TransferError();
        const snapshot = validateSnapshot(input);
        const contents: {
            extension: string;
            content: string;
        }[] = [];
        if (format !== 'csv')
            contents.push({ extension: 'json', content: canonicalJson(snapshot) + '\n' });
        if (format !== 'json')
            contents.push({ extension: 'csv', content: snapshotCsv(snapshot) });
        if (contents.some(file => Buffer.byteLength(file.content) > MAX_SNAPSHOT_BYTES))
            throw new TransferError();
        const target = await outsideRepository(directory);
        const stem = 'career-private-' + new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID();
        const files: string[] = [];
        for (const { extension, content } of contents) {
            const filename = path.join(target, stem + '.' + extension);
            const temporary = filename + '.partial';
            const handle = await open(temporary, 'wx', 0o600);
            try {
                await handle.writeFile(content, 'utf8');
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await link(temporary, filename);
            await unlink(temporary);
            files.push(filename);
        }
        return files;
    }
    catch {
        throw new TransferError();
    }
}
export async function readPrivateSnapshot(file: string): Promise<Snapshot> {
    try {
        const directory = await outsideRepository(path.dirname(path.resolve(file)));
        const target = path.join(directory, path.basename(file));
        const before = await lstat(target);
        if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_SNAPSHOT_BYTES)
            throw new TransferError();
        const handle = await open(target, 'r');
        let text: string;
        try {
            const opened = await handle.stat();
            if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size)
                throw new TransferError();
            const bytes = Buffer.alloc(opened.size);
            let position = 0;
            while (position < bytes.length) {
                const result = await handle.read(bytes, position, bytes.length - position, position);
                if (!result.bytesRead)
                    throw new TransferError();
                position += result.bytesRead;
            }
            if ((await handle.read(Buffer.alloc(1), 0, 1, position)).bytesRead)
                throw new TransferError();
            const after = await lstat(target);
            if (after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size || await realpath(target) !== target)
                throw new TransferError();
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        finally {
            await handle.close();
        }
        return validateSnapshot(JSON.parse(text));
    }
    catch {
        throw new TransferError();
    }
}
