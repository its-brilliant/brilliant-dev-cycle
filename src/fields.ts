import { got, push, type Issue } from './issues.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function unknownFields(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  file: string,
  base: string,
  issues: Issue[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const path = base ? `${base}.${key}` : key;
      push(issues, file, path, 'unknown field');
    }
  }
}

export function expectRecord(
  value: unknown,
  file: string,
  path: string,
  issues: Issue[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    push(issues, file, path, `expected a mapping, got ${got(value)}`);
    return undefined;
  }
  return value;
}

export function expectString(
  value: unknown,
  file: string,
  path: string,
  issues: Issue[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    push(issues, file, path, `expected a non-empty string, got ${got(value)}`);
    return undefined;
  }
  return value;
}

export function expectBool(
  value: unknown,
  file: string,
  path: string,
  issues: Issue[],
): boolean | undefined {
  if (typeof value !== 'boolean') {
    push(issues, file, path, `expected a boolean, got ${got(value)}`);
    return undefined;
  }
  return value;
}

export function expectInt(
  value: unknown,
  file: string,
  path: string,
  issues: Issue[],
  min: number,
): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    push(issues, file, path, `expected an integer >= ${min}, got ${got(value)}`);
    return undefined;
  }
  return value;
}

export function expectEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  file: string,
  path: string,
  issues: Issue[],
): T | undefined {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    push(issues, file, path, `expected one of ${allowed.join(', ')}, got ${got(value)}`);
    return undefined;
  }
  return value as T;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeId(value: string): boolean {
  return ID_RE.test(value);
}

export function expectId(
  value: unknown,
  file: string,
  path: string,
  issues: Issue[],
): string | undefined {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    push(
      issues,
      file,
      path,
      `expected an id (letters, digits, ".", "_", "-"), got ${got(value)}`,
    );
    return undefined;
  }
  return value;
}

/** At least one slash, no empty segments, no whitespace. Accepts GitLab subgroups. */
const PROJECT_PATH_RE = /^[^/\s]+(?:\/[^/\s]+)+$/;

export function expectProjectPath(
  value: unknown,
  file: string,
  path: string,
  issues: Issue[],
): string | undefined {
  if (typeof value !== 'string' || !PROJECT_PATH_RE.test(value)) {
    push(issues, file, path, `expected a path like "org/app", got ${got(value)}`);
    return undefined;
  }
  return value;
}

export function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
