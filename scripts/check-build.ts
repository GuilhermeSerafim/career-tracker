import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, loadEnv } from 'vite';

const publicKeys = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'];
export function inspectPublicArtifact(text: string, canaries: string[]): void {
  if (canaries.some(value => text.includes(value)) ||
      /ct_agent_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}|sb_secret_[A-Za-z0-9_-]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@|https?:\/\/[^\s"'/]+:[^\s"'/]+@/i.test(text) ||
      /\b[\w.-]+-(?:tracker|workspace)-private\b|Controle (?:de|das) candidaturas|C:\\Users\\|source_files\/|legacy\.csv|revisao-ficticia\.md|jobs\.example\.org\/42|Empresa, Exemplo|https?:\/\/[^\s"']+[?&](?:access_token|token|password)=/.test(text) ||
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text)) {
    throw Error('Artefato público contém material privado ou segredo sintético.');
  }
}
export async function checkBuild() {
  const publicEnv = { ...loadEnv('production', process.cwd(), 'VITE_'), ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('VITE_'))) };
  if (Object.keys(publicEnv).some(key => !publicKeys.includes(key))) throw Error('Variável VITE_* não aprovada.');
  const canaries = [randomBytes(32).toString('hex'), randomBytes(32).toString('base64url'), `ct_agent_${randomUUID()}.${randomBytes(32).toString('base64url')}`, `postgresql://synthetic:${randomBytes(24).toString('hex')}@private.invalid/private`];
  Object.assign(process.env, { SERVER_SECRET_CANARY: canaries[0], CAREER_AGENT_TOKEN_HASH: canaries[0], OWNER_INITIAL_PASSWORD: canaries[1], SUPABASE_SECRET_KEY: canaries[1], CAREER_AGENT_TOKEN: canaries[2], DATABASE_URL: canaries[3] });
  let initialModules = 0;
  await build({ build: { manifest: true }, plugins: [{ name: 'verify-initial-module-graph', generateBundle(_options, bundle) {
    const visited = new Set<string>();
    const visit = (name: string) => {
      if (visited.has(name)) return; visited.add(name);
      const chunk = bundle[name]; if (!chunk || chunk.type !== 'chunk') return;
      initialModules += Object.keys(chunk.modules).length;
      if (Object.keys(chunk.modules).some(id => /node_modules[\\/](echarts|zrender)[\\/]/.test(id))) throw Error('Gráficos presentes no carregamento inicial.');
      chunk.imports.forEach(visit);
    };
    Object.values(bundle).filter(item => item.type === 'chunk' && item.isEntry).forEach(item => visit(item.fileName));
  } }] });
  let artifacts = 0;
  const scan = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else {
        if (!/\.(html|js|css|json|svg|ico|woff2?)$/.test(entry.name)) throw Error('Build contém formato não aprovado ou arquivo de origem.');
        inspectPublicArtifact(await readFile(path, 'utf8'), canaries); artifacts++;
      }
    }
  };
  await scan(resolve('dist'));
  console.log(JSON.stringify({ privacy: 'PASS', artifacts, initialModules, initialECharts: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkBuild().catch(() => { console.error('Verificação de privacidade/build falhou; nenhum segredo foi exibido.'); process.exitCode = 1; });
}
