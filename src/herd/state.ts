import { expectEnum, expectId, expectInt, expectRecord, hasOwn, unknownFields } from '../fields.js';
import { got, push, type Issue } from '../issues.js';
import {
  PHASE_STATUSES,
  PHASE_STEPS,
  STAGES,
  TASK_STATUSES,
  type Phase,
  type PhaseState,
  type RunState,
  type Stage,
  type TaskState,
} from './types.js';

const STATE_KEYS = ['version', 'run_id', 'stage', 'phases'] as const;
const PHASE_KEYS = ['status', 'step', 'verify_attempt', 'tasks'] as const;
const TASK_KEYS = ['status'] as const;

export interface RunStateParseResult {
  state: RunState | null;
  issues: Issue[];
}

export function initialRunState(runId: string, phases: readonly Phase[], stage: Stage = 'build'): RunState {
  const phaseStates: Record<string, PhaseState> = {};
  for (const phase of phases) {
    const tasks: Record<string, TaskState> = {};
    for (const task of phase.tasks) tasks[task.id] = { status: 'not_started' };
    phaseStates[phase.id] = { status: 'not_started', tasks };
  }
  return { version: 1, run_id: runId, stage, phases: phaseStates };
}

export function parseRunStateJson(text: string, file: string): RunStateParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON';
    return { state: null, issues: [{ file, path: '', message: `invalid JSON (${message})` }] };
  }
  return parseRunState(value, file);
}

export function parseRunState(value: unknown, file: string): RunStateParseResult {
  const issues: Issue[] = [];
  const root = expectRecord(value, file, '', issues);
  if (!root) return { state: null, issues };
  unknownFields(root, STATE_KEYS, file, '', issues);

  if (!hasOwn(root, 'version')) push(issues, file, 'version', 'required');
  else if (root.version !== 1) push(issues, file, 'version', `expected version 1, got ${got(root.version)}`);

  let runId: string | undefined;
  if (!hasOwn(root, 'run_id')) push(issues, file, 'run_id', 'required');
  else runId = expectId(root.run_id, file, 'run_id', issues);

  let stage: RunState['stage'] | undefined;
  if (!hasOwn(root, 'stage')) push(issues, file, 'stage', 'required');
  else stage = expectEnum(root.stage, STAGES, file, 'stage', issues);

  const phases = parsePhaseMap(root, file, issues);
  if (issues.length > 0 || runId === undefined || stage === undefined || !phases) {
    return { state: null, issues };
  }
  return { state: { version: 1, run_id: runId, stage, phases }, issues };
}

function parsePhaseMap(
  root: Record<string, unknown>,
  file: string,
  issues: Issue[],
): Record<string, PhaseState> | undefined {
  if (!hasOwn(root, 'phases')) {
    push(issues, file, 'phases', 'required');
    return undefined;
  }
  const phases = expectRecord(root.phases, file, 'phases', issues);
  if (!phases) return undefined;
  const parsed: Record<string, PhaseState> = {};
  let ok = true;
  for (const id of Object.keys(phases)) {
    const path = `phases.${id}`;
    if (expectId(id, file, path, issues) === undefined) {
      ok = false;
      continue;
    }
    const phase = parsePhaseState(phases[id], file, path, issues);
    if (!phase) ok = false;
    else parsed[id] = phase;
  }
  return ok ? parsed : undefined;
}

function parsePhaseState(value: unknown, file: string, path: string, issues: Issue[]): PhaseState | undefined {
  const obj = expectRecord(value, file, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  unknownFields(obj, PHASE_KEYS, file, path, issues);

  let status: PhaseState['status'] | undefined;
  if (!hasOwn(obj, 'status')) push(issues, file, `${path}.status`, 'required');
  else status = expectEnum(obj.status, PHASE_STATUSES, file, `${path}.status`, issues);

  let step: PhaseState['step'] | undefined;
  if (hasOwn(obj, 'step')) step = expectEnum(obj.step, PHASE_STEPS, file, `${path}.step`, issues);
  if (status === 'in_progress' && !hasOwn(obj, 'step')) {
    push(issues, file, `${path}.step`, 'step is required when status is in_progress');
  }

  let verifyAttempt: number | undefined;
  if (hasOwn(obj, 'verify_attempt')) {
    verifyAttempt = expectInt(obj.verify_attempt, file, `${path}.verify_attempt`, issues, 1);
  }
  if (step === 'verify' && !hasOwn(obj, 'verify_attempt')) {
    push(issues, file, `${path}.verify_attempt`, 'verify_attempt is required when step is verify');
  }

  const tasks = parseTasks(obj, file, path, issues);
  if (issues.length > before || status === undefined || !tasks) return undefined;
  const state: PhaseState = { status, tasks };
  if (step) state.step = step;
  if (verifyAttempt !== undefined) state.verify_attempt = verifyAttempt;
  return state;
}

function parseTasks(
  obj: Record<string, unknown>,
  file: string,
  path: string,
  issues: Issue[],
): Record<string, TaskState> | undefined {
  const tasksPath = `${path}.tasks`;
  if (!hasOwn(obj, 'tasks')) {
    push(issues, file, tasksPath, 'required');
    return undefined;
  }
  const tasks = expectRecord(obj.tasks, file, tasksPath, issues);
  if (!tasks) return undefined;
  const parsed: Record<string, TaskState> = {};
  let ok = true;
  for (const id of Object.keys(tasks)) {
    const taskPath = `${tasksPath}.${id}`;
    if (expectId(id, file, taskPath, issues) === undefined) {
      ok = false;
      continue;
    }
    const task = expectRecord(tasks[id], file, taskPath, issues);
    if (!task) {
      ok = false;
      continue;
    }
    unknownFields(task, TASK_KEYS, file, taskPath, issues);
    if (!hasOwn(task, 'status')) {
      push(issues, file, `${taskPath}.status`, 'required');
      ok = false;
      continue;
    }
    const status = expectEnum(task.status, TASK_STATUSES, file, `${taskPath}.status`, issues);
    if (status === undefined) ok = false;
    else parsed[id] = { status };
  }
  return ok ? parsed : undefined;
}
