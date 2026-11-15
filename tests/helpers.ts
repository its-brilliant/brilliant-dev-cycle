import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatIssue, type Issue } from '../src/issues.js';

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

export function lines(issues: Issue[]): string[] {
  return issues.map((issue) => formatIssue(issue));
}
