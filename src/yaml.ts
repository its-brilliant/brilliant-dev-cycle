import { parseDocument } from 'yaml';
import { push, type Issue } from './issues.js';

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') {
      return message.split('\n')[0] ?? message;
    }
  }
  return 'invalid YAML';
}

function errorLine(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('linePos' in error)) return undefined;
  const linePos = (error as { linePos?: Array<{ line?: number } | null> }).linePos;
  const line = linePos?.[0]?.line;
  return typeof line === 'number' ? line : undefined;
}

/** Parse a YAML document. Schema checks run only when the document is syntactically valid. */
export function parseYaml(text: string, file: string): { value: unknown; issues: Issue[] } {
  const doc = parseDocument(text, { uniqueKeys: true });
  const issues: Issue[] = [];
  for (const error of doc.errors) {
    const line = errorLine(error);
    push(issues, file, line ? `line ${line}` : '', errorMessage(error));
  }
  if (issues.length > 0) return { value: undefined, issues };
  return { value: doc.toJS({ maxAliasCount: 50 }), issues };
}
