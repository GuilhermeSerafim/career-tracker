import type { Command } from '../../shared/commands';

type ContactCommand = Extract<Command, { operation: 'save_contact' }>;
/** Fictional valid fields with an independently requested UTF-8 command-body size. */
export function contactAtByteBoundary(bodyBytes = 262_134, target: ContactCommand['target'] = { clientId: '44444444-4444-4444-8444-444444444444' }): ContactCommand {
  const links = Array.from({ length: 50 }, (_, index) => {
    const prefix = `https://example.test/${index}/`;
    return { originalUrl: prefix + 'a'.repeat(4096 - prefix.length), comparisonUrl: null, kind: 'contato', isLocal: false, isPrivate: true };
  });
  const command: ContactCommand = { operation: 'save_contact', target, data: { name: null, notes: '', links } };
  const missing = bodyBytes - new TextEncoder().encode(JSON.stringify(command)).byteLength;
  if (missing < 0) throw new Error('Fixture size is smaller than its links.');
  command.data.notes = 'é'.repeat(Math.floor(missing / 2)) + (missing % 2 ? 'a' : '');
  return command;
}
