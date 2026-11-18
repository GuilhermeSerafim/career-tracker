import { expect, it } from 'vitest';
import { inspectPublicArtifact } from '../../scripts/check-build';

it('recusa canários, credenciais e arquivos privados sem reproduzir seu conteúdo', () => {
  for (const text of ['synthetic-canary', 'postgresql://user:synthetic@private.invalid/db', 'sb_secret_synthetic', 'synthetic-workspace-private', 'synthetic-tracker-private/arquivo', 'legacy.csv']) {
    expect(() => inspectPublicArtifact(text, ['synthetic-canary'])).toThrow();
  }
  expect(() => inspectPublicArtifact('scripts/export-private.ts scripts/restore-private.ts', [])).not.toThrow();
  expect(() => inspectPublicArtifact('https://public.supabase.co sb_publishable_public', [])).not.toThrow();
});
