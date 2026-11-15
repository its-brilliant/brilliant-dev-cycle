import type { EnvConfig, VerifyConfig } from '../config/types.js';

export interface PhaseTask {
  id: string;
  title: string;
}

export interface Phase {
  id: string;
  title: string;
  deps: string[];
  tasks: PhaseTask[];
  /** Every phase brings up its own side env before tasks run. */
  env: EnvConfig;
  /** A phase must pass verify before dependents start. */
  verify: VerifyConfig;
}

/** A line-anchored comment or reply in `comments/spec.vN.jsonl`. */
export interface LineComment {
  id: string;
  /** 1-based line in the versioned spec. */
  line: number;
  author: string;
  body: string;
  /** Set when this record replies to another comment in the same file. */
  parent_id: string | null;
  created_at?: string;
}

export const STAGES = ['spec', 'phases', 'build', 'final_review', 'pr'] as const;
export type Stage = (typeof STAGES)[number];

/** Statuses the progress view reads from `state.json`. */
export const PHASE_STATUSES = ['not_started', 'queued', 'in_progress', 'blocked', 'done'] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

/** Steps inside the build loop. `queued` phases are waiting for an env slot and have no step. */
export const PHASE_STEPS = ['env_up', 'tasks', 'merge', 'review', 'verify', 'env_down'] as const;
export type PhaseStep = (typeof PHASE_STEPS)[number];

export const TASK_STATUSES = ['not_started', 'in_progress', 'blocked', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskState {
  status: TaskStatus;
}

export interface PhaseState {
  status: PhaseStatus;
  step?: PhaseStep;
  /** 1-based verify attempt. Required while `step` is `verify`. */
  verify_attempt?: number;
  tasks: Record<string, TaskState>;
}

export interface RunState {
  version: 1;
  run_id: string;
  stage: Stage;
  phases: Record<string, PhaseState>;
}

export const QUESTION_STATUSES = ['pending', 'answered'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** One record in `runs/<id>/questions.jsonl`. Questions do not stop the whole DAG. */
export interface PmQuestion {
  id: string;
  prompt: string;
  status: QuestionStatus;
  phase_id?: string;
  task_id?: string;
  answer?: string;
  created_at?: string;
}
