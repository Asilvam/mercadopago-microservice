const SENSITIVE_KEY = /authorization|cookie|password|secret|signature|token|access[_-]?token|api[_-]?key/i;
const EMAIL = /\b([A-Z0-9._%+-])[^@\s]*(@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi;

const MAX_DEPTH = 6;
const MAX_KEYS = 60;
const MAX_ARRAY_ITEMS = 30;
const MAX_STRING_LENGTH = 2_000;

export type SanitizationStats = {
  redactedFields: number;
  truncatedValues: number;
};

export function sanitizeForPersistence(value: unknown, stats: SanitizationStats = { redactedFields: 0, truncatedValues: 0 }, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;

  if (typeof value === 'string') {
    const truncated = value.length > MAX_STRING_LENGTH;
    if (truncated) stats.truncatedValues += 1;
    return value.slice(0, MAX_STRING_LENGTH).replace(EMAIL, (_match, first: string, domain: string) => `${first}***${domain}`);
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (depth >= MAX_DEPTH) {
    stats.truncatedValues += 1;
    return '[MAX_DEPTH]';
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) stats.truncatedValues += 1;
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeForPersistence(item, stats, depth + 1));
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_KEYS) stats.truncatedValues += 1;

    return Object.fromEntries(
      entries.slice(0, MAX_KEYS).map(([key, item]) => {
        if (SENSITIVE_KEY.test(key)) {
          stats.redactedFields += 1;
          return [key, '[REDACTED]'];
        }
        return [key, sanitizeForPersistence(item, stats, depth + 1)];
      }),
    );
  }

  return String(value);
}

export function sanitizeRecord(value: Record<string, unknown> | undefined, stats?: SanitizationStats): Record<string, unknown> {
  const sanitized = sanitizeForPersistence(value ?? {}, stats);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? (sanitized as Record<string, unknown>) : {};
}
