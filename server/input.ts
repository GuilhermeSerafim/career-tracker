import { SafeError } from './errors.js';
/** PostgreSQL text/JSONB recusam NUL e surrogates isolados; não normalizar texto. */
export function assertRepresentableJson(input: unknown, depth = 0): void {
  if (depth > 64) throw new SafeError('INVALID_INPUT');
  if (typeof input === 'string') {
    if (
      input.includes('\0') ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)
    )
      throw new SafeError('INVALID_INPUT');
  } else if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      assertRepresentableJson(key, depth + 1);
      assertRepresentableJson(value, depth + 1);
    }
  }
}
