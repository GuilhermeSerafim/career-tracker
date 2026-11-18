import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHumanAuthenticator } from '../server/auth';
import { readServerConfig } from '../server/config';
import { createDatabase } from '../server/database';
import { createExportService } from '../server/services/exports';
import { TransferError } from '../domain/export';
import { writePrivateExport } from './private-transfer-io';
export async function exportPrivateMain(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    let directory: string | undefined;
    let format: 'json' | 'csv' | 'both' = 'both';
    let selected = false;
    for (let index = 0; index < args.length; index += 2) {
        const key = args[index], value = args[index + 1];
        if (!value || value.startsWith('--'))
            throw new TransferError();
        if (key === '--private-dir' && directory === undefined)
            directory = value;
        else if (key === '--format' && !selected && ['json', 'csv', 'both'].includes(value)) {
            format = value as typeof format;
            selected = true;
        }
        else
            throw new TransferError();
    }
    if (!directory || !env.OWNER_SESSION_TOKEN)
        throw new TransferError();
    const config = readServerConfig(env);
    const actor = await createHumanAuthenticator(config)('Bearer ' + env.OWNER_SESSION_TOKEN);
    const database = createDatabase(config);
    try {
        return await writePrivateExport(directory, await createExportService(database).json(actor), format);
    }
    finally {
        await database.close();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    exportPrivateMain(process.argv.slice(2)).then(files => console.log('Exportação privada concluída: ' + files.map(file => path.basename(file)).join(', ')))
        .catch(() => { console.error('Falha na exportação privada. Confira sessão, configuração, destino e limites; nenhum arquivo parcial é backup.'); process.exitCode = 1; });
}
