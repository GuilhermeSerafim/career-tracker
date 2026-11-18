import { config } from 'zod';

// Run before shared schemas load. Strict CSP forbids even Zod's caught eval
// capability probe; its supported interpreter preserves validation semantics.
config({ jitless: true });
