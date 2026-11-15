import { expectId, expectInt, expectRecord, expectString, hasOwn, unknownFields } from '../fields.js';
import { push, type Issue } from '../issues.js';
import { isIsoUtc } from '../time.js';
import type { LineComment } from './types.js';

const COMMENT_KEYS = ['id', 'line', 'author', 'body', 'parent_id', 'created_at'] as const;

export interface CommentBounds {
  maxLine: number;
  specFile: string;
}

export interface CommentsParseResult {
  comments: LineComment[] | null;
  issues: Issue[];
}

export function parseComments(
  text: string,
  file: string,
  bounds?: CommentBounds,
): CommentsParseResult {
  const issues: Issue[] = [];
  const comments: LineComment[] = [];
  const lines = text.split(/\r?\n/);
  const ids = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '') continue;
    const source = `line ${i + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid JSON';
      push(issues, file, source, `invalid JSON (${message})`);
      continue;
    }
    const comment = parseComment(value, file, source, bounds, issues);
    if (!comment) continue;
    if (ids.has(comment.id)) {
      push(issues, file, source, `duplicate comment id ${JSON.stringify(comment.id)}`);
      continue;
    }
    ids.add(comment.id);
    comments.push(comment);
  }

  const known = new Set(comments.map((comment) => comment.id));
  for (const comment of comments) {
    if (comment.parent_id === null) continue;
    if (comment.parent_id === comment.id) {
      push(issues, file, `id ${comment.id}`, 'parent_id refers to itself');
      continue;
    }
    if (!known.has(comment.parent_id)) {
      push(
        issues,
        file,
        `id ${comment.id}`,
        `parent_id ${JSON.stringify(comment.parent_id)} does not match a comment`,
      );
    }
  }

  if (issues.length > 0) return { comments: null, issues };
  return { comments, issues };
}

function parseComment(
  value: unknown,
  file: string,
  source: string,
  bounds: CommentBounds | undefined,
  issues: Issue[],
): LineComment | undefined {
  const obj = expectRecord(value, file, source, issues);
  if (!obj) return undefined;
  const before = issues.length;
  unknownFields(obj, COMMENT_KEYS, file, source, issues);

  const id = requireId(obj, file, source, issues);
  const line = requireLine(obj, file, source, bounds, issues);
  const author = requireText(obj, 'author', file, source, issues);
  const body = requireText(obj, 'body', file, source, issues);
  const parent = parseParent(obj, file, source, issues);
  const created = parseCreatedAt(obj, file, source, issues);
  if (
    id === undefined ||
    line === undefined ||
    author === undefined ||
    body === undefined ||
    parent === 'invalid' ||
    created === 'invalid' ||
    issues.length > before
  ) {
    return undefined;
  }
  const comment: LineComment = { id, line, author, body, parent_id: parent };
  if (created) comment.created_at = created;
  return comment;
}

function requireId(obj: Record<string, unknown>, file: string, source: string, issues: Issue[]): string | undefined {
  if (!hasOwn(obj, 'id')) {
    push(issues, file, `${source}.id`, 'required');
    return undefined;
  }
  return expectId(obj.id, file, `${source}.id`, issues);
}

function requireLine(
  obj: Record<string, unknown>,
  file: string,
  source: string,
  bounds: CommentBounds | undefined,
  issues: Issue[],
): number | undefined {
  const path = `${source}.line`;
  if (!hasOwn(obj, 'line')) {
    push(issues, file, path, 'required');
    return undefined;
  }
  const line = expectInt(obj.line, file, path, issues, 1);
  if (line === undefined) return undefined;
  if (bounds && line > bounds.maxLine) {
    push(
      issues,
      file,
      path,
      `comment line ${line} is outside ${bounds.specFile} (${bounds.maxLine} lines)`,
    );
    return undefined;
  }
  return line;
}

function requireText(
  obj: Record<string, unknown>,
  key: 'author' | 'body',
  file: string,
  source: string,
  issues: Issue[],
): string | undefined {
  const path = `${source}.${key}`;
  if (!hasOwn(obj, key)) {
    push(issues, file, path, 'required');
    return undefined;
  }
  return expectString(obj[key], file, path, issues);
}

function parseParent(
  obj: Record<string, unknown>,
  file: string,
  source: string,
  issues: Issue[],
): string | null | 'invalid' {
  if (!hasOwn(obj, 'parent_id')) return null;
  if (obj.parent_id === null) return null;
  const parent = expectId(obj.parent_id, file, `${source}.parent_id`, issues);
  return parent === undefined ? 'invalid' : parent;
}

function parseCreatedAt(
  obj: Record<string, unknown>,
  file: string,
  source: string,
  issues: Issue[],
): string | undefined | 'invalid' {
  if (!hasOwn(obj, 'created_at')) return undefined;
  const path = `${source}.created_at`;
  if (typeof obj.created_at !== 'string' || !isIsoUtc(obj.created_at)) {
    push(issues, file, path, `expected an ISO-8601 UTC timestamp (2026-01-01T00:00:00Z), got ${JSON.stringify(obj.created_at)}`);
    return 'invalid';
  }
  return obj.created_at;
}
