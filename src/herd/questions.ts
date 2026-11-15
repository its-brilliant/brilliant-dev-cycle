import { expectEnum, expectId, expectRecord, expectString, hasOwn, unknownFields } from '../fields.js';
import { got, push, type Issue } from '../issues.js';
import { isIsoUtc } from '../time.js';
import { QUESTION_STATUSES, type PmQuestion } from './types.js';

const QUESTION_KEYS = ['id', 'prompt', 'status', 'phase_id', 'task_id', 'answer', 'created_at'] as const;

export interface QuestionsParseResult {
  questions: PmQuestion[] | null;
  issues: Issue[];
}

export function parseQuestions(text: string, file: string): QuestionsParseResult {
  const issues: Issue[] = [];
  const questions: PmQuestion[] = [];
  const ids = new Set<string>();
  const lines = text.split(/\r?\n/);

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
    const question = parseQuestion(value, file, source, issues);
    if (!question) continue;
    if (ids.has(question.id)) {
      push(issues, file, source, `duplicate question id ${JSON.stringify(question.id)}`);
      continue;
    }
    ids.add(question.id);
    questions.push(question);
  }

  if (issues.length > 0) return { questions: null, issues };
  return { questions, issues };
}

function parseQuestion(value: unknown, file: string, source: string, issues: Issue[]): PmQuestion | undefined {
  const obj = expectRecord(value, file, source, issues);
  if (!obj) return undefined;
  const before = issues.length;
  unknownFields(obj, QUESTION_KEYS, file, source, issues);

  const id = requireId(obj, 'id', file, source, issues);
  const prompt = requireString(obj, 'prompt', file, source, issues);
  let status: PmQuestion['status'] | undefined;
  if (!hasOwn(obj, 'status')) push(issues, file, `${source}.status`, 'required');
  else status = expectEnum(obj.status, QUESTION_STATUSES, file, `${source}.status`, issues);

  const phaseId = optionalId(obj, 'phase_id', file, source, issues);
  const taskId = optionalId(obj, 'task_id', file, source, issues);
  if (taskId && phaseId === undefined && !hasOwn(obj, 'phase_id')) {
    push(issues, file, `${source}.phase_id`, 'phase_id is required when task_id is set');
  }

  let answer: string | undefined;
  if (hasOwn(obj, 'answer')) {
    answer = expectString(obj.answer, file, `${source}.answer`, issues);
    if (status === 'pending') {
      push(issues, file, `${source}.answer`, 'answer is only set when status is answered');
    }
  } else if (status === 'answered') {
    push(issues, file, `${source}.answer`, 'answer is required when status is answered');
  }

  const created = parseCreatedAt(obj, file, source, issues);
  if (
    id === undefined ||
    prompt === undefined ||
    status === undefined ||
    phaseId === 'invalid' ||
    taskId === 'invalid' ||
    created === 'invalid' ||
    issues.length > before
  ) {
    return undefined;
  }

  const question: PmQuestion = { id, prompt, status };
  if (typeof phaseId === 'string') question.phase_id = phaseId;
  if (typeof taskId === 'string') question.task_id = taskId;
  if (answer !== undefined) question.answer = answer;
  if (typeof created === 'string') question.created_at = created;
  return question;
}

function requireId(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  source: string,
  issues: Issue[],
): string | undefined {
  if (!hasOwn(obj, key)) {
    push(issues, file, `${source}.${key}`, 'required');
    return undefined;
  }
  return expectId(obj[key], file, `${source}.${key}`, issues);
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  source: string,
  issues: Issue[],
): string | undefined {
  if (!hasOwn(obj, key)) {
    push(issues, file, `${source}.${key}`, 'required');
    return undefined;
  }
  return expectString(obj[key], file, `${source}.${key}`, issues);
}

function optionalId(
  obj: Record<string, unknown>,
  key: 'phase_id' | 'task_id',
  file: string,
  source: string,
  issues: Issue[],
): string | undefined | 'invalid' {
  if (!hasOwn(obj, key)) return undefined;
  const id = expectId(obj[key], file, `${source}.${key}`, issues);
  return id === undefined ? 'invalid' : id;
}

function parseCreatedAt(
  obj: Record<string, unknown>,
  file: string,
  source: string,
  issues: Issue[],
): string | undefined | 'invalid' {
  if (!hasOwn(obj, 'created_at')) return undefined;
  if (typeof obj.created_at !== 'string' || !isIsoUtc(obj.created_at)) {
    push(
      issues,
      file,
      `${source}.created_at`,
      `expected an ISO-8601 UTC timestamp (2026-01-01T00:00:00Z), got ${got(obj.created_at)}`,
    );
    return 'invalid';
  }
  return obj.created_at;
}
