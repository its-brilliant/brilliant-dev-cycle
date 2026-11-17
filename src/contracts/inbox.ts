/**
 * How an agent's result reaches bdc (spec §3.4). The agent calls a submit tool (MCP, or the
 * `bdc submit` command, which does the same); the tool validates the submission with the schema
 * of its kind and appends it to the job's inbox. The observer of that job (src/effects/hc.ts)
 * watches the inbox and turns each new entry into one OBS_SUBMITTED.
 *
 * Every agent terminal is started with the AGENT_ENV variables, so the tool knows whose
 * submission it is without the agent having to say.
 */
import path from 'node:path';
import { z } from 'zod';
import type { SubmitKind } from './actors.js';
import { Brief, Decision, Findings, Plan, ProofKind } from './domain.js';

export const AGENT_ENV = {
  root: 'BDC_ROOT',
  run: 'BDC_RUN',
  key: 'BDC_KEY',
  role: 'BDC_ROLE',
  submit: 'BDC_SUBMIT',
} as const;

/** What each submit kind accepts. The tool rejects anything else, with the exact problems. */
export const SUBMISSIONS = {
  brief: Brief,
  reply: z.object({ text: z.string().min(1) }),
  decision: Decision,
  spec: z.object({ markdown: z.string().min(1), notes: z.array(z.string()).default([]) }),
  plan: Plan,
  task: z.object({ summary: z.string().min(1), notes: z.array(z.string()).default([]) }),
  findings: Findings,
  proof: z.object({
    items: z.array(z.object({ kind: ProofKind, shows: z.string().default(''), file: z.string().optional() })),
  }),
} satisfies Record<SubmitKind, z.ZodType>;

/** One line of a job's inbox. `seq` counts from 1 per job; a follow-up turn gets the next one. */
export const InboxEntry = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  kind: z.enum(['brief', 'reply', 'decision', 'spec', 'plan', 'task', 'findings', 'proof']),
  submission: z.unknown(),
});
export type InboxEntry = z.infer<typeof InboxEntry>;

/** Job keys contain `/`; file names do not. */
export function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** `.herd/runs/<run>/agents/<key>/`: everything bdc keeps about one agent job. */
export function agentDir(root: string, runId: string, key: string): string {
  return path.join(root, '.herd', 'runs', runId, 'agents', safeKey(key));
}

/** Append-only JSON lines of InboxEntry. */
export function inboxFile(dir: string): string {
  return path.join(dir, 'inbox.jsonl');
}

/** The highest `seq` the observer has already turned into OBS_SUBMITTED, so a restarted observer does not repeat it. */
export function deliveredFile(dir: string): string {
  return path.join(dir, 'delivered');
}
