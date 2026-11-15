const SPEC_FILE = /^spec\.v([1-9]\d*)\.md$/;
const COMMENT_FILE = /^spec\.v([1-9]\d*)\.jsonl$/;

export function specVersion(name: string): number | undefined {
  const match = SPEC_FILE.exec(name);
  return match ? Number(match[1]) : undefined;
}

export function commentVersion(name: string): number | undefined {
  const match = COMMENT_FILE.exec(name);
  return match ? Number(match[1]) : undefined;
}

/** Trailing newline does not create an extra line. An empty file has zero lines. */
export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split(/\r?\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}
