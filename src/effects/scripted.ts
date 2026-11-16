/**
 * Scripted effects: deterministic stand-ins for every actor the machines inject (spec §12.4).
 *
 * They exist so a whole run can go from a goal to a pull request without hc, a real agent CLI or
 * git — in the end-to-end tests and in `bdc demo`. Nothing here is a machine: timers and the
 * filesystem are allowed, and everything is deterministic (a fixed delay between observations, one
 * fixed submission per job kind).
 *
 * Two registries live outside machine context on purpose (§5.7):
 * - `scriptedLaunches` remembers which job keys were launched, so a restore re-attaches instead of
 *   starting a second agent, and a test can count launches;
 * - the last text sent to a terminal, so the observer can answer a PM follow-up with the artifact
 *   that turn asks for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fromCallback, fromPromise } from 'xstate';
import type {
  CheckProofInput,
  CheckProofOutput,
  CloseAgentInput,
  CommitsSinceInput,
  CommitsSinceOutput,
  EnsureWorktreeInput,
  EnsureWorktreeOutput,
  LaunchAgentInput,
  LaunchAgentOutput,
  MergeBranchInput,
  MergeBranchOutput,
  ObserveAgentInput,
  ProofItem,
  RunVerificationInput,
  RunVerificationOutput,
  SendToAgentInput,
  SubmitKind,
} from '../contracts/actors.js';
import type { Brief, Decision, Finding, Plan } from '../contracts/domain.js';
import type { AgentObservation } from '../contracts/events.js';
import type { AgentJob } from '../contracts/actors.js';
import type { OpenPullRequestInput, OpenPullRequestOutput } from '../machines/run.js';
import type { WiredEffects } from '../runtime/wire.js';

export interface ScriptedOptions {
  /** How long between two observations of one agent. 0 (the default) is still a macrotask, so a
   * follow-up that was just pasted into the terminal is on record before the observer reads it. */
  delayMs?: number;
  /** The run's goal: the scripted spec and pull request are written from it. */
  goal?: string;
}

/** One `launchAgent` call, for a test that wants to prove nothing was launched twice. */
export interface ScriptedLaunch {
  key: string;
  reattached: boolean;
}

/** Launch bookkeeping, keyed by `job.key` (§3.2). Outside machine context: a restore must see it. */
export const scriptedLaunches = {
  byKey: new Map<string, { launches: number; reattached: number }>(),
  log: [] as ScriptedLaunch[],
  reset(): void {
    this.byKey.clear();
    this.log.length = 0;
  },
};

/** Every `sendToAgent` call, in order: follow-ups, nudges and prompt choices. */
export const scriptedSends: SendToAgentInput[] = [];
/** The terminals `closeAgent` was called for. */
export const scriptedCloses: string[] = [];

/** The last text pasted into a terminal: what a PM follow-up asks for. */
const sentText = new Map<string, string>();
/** The plan each run was given, so the scripted pull request can list its phases. */
const plansByRun = new Map<string, Plan>();

/** The two-phase plan every planner job submits; `p2` waits for `p1` (§4.3). */
export function scriptedPlan(): Plan {
  return {
    phases: [
      {
        id: 'p1',
        title: 'First phase',
        deps: [],
        tasks: [{ id: 't1', title: 'Do the first thing', paths: [] }],
        checks: [],
        proof: [{ kind: 'tests', shows: '' }],
      },
      {
        id: 'p2',
        title: 'Second phase',
        deps: ['p1'],
        tasks: [{ id: 't2', title: 'Do the second thing', paths: [] }],
        checks: [],
        proof: [{ kind: 'tests', shows: '' }],
      },
    ],
  };
}

/** What a scripted submit tool accepts: one artifact shape per submit kind (§3.4). */
type ScriptedSubmission =
  | Brief
  | { markdown: string }
  | Plan
  | { summary: string }
  | { findings: Finding[] }
  | Decision
  | { text: string }
  | { items: ProofItem[] };

/**
 * What a job's submit tool accepts (§3.4). The PM's turn kind comes from the request it was just
 * sent (`decide`, `submit_brief`, `reply`); every other role has one submit kind for the job.
 */
function submissionFor(job: AgentJob, terminal: string, options: ScriptedOptions): ScriptedSubmission {
  const kind: SubmitKind = job.role === 'pm' ? pmSubmitKind(job, terminal) : job.submit;
  switch (kind) {
    case 'brief':
      return { brief: job.prompt, decisions: [], assumptions: [] };
    case 'spec':
      return { markdown: `# Spec\n\n${options.goal ?? ''}` };
    case 'plan': {
      const plan = scriptedPlan();
      plansByRun.set(job.labels['bdc.run'] ?? '', plan);
      return plan;
    }
    case 'task':
      return { summary: 'done' };
    case 'findings':
      return job.prompt.includes('BLOCK')
        ? { findings: [{ id: 'scripted-1', severity: 'high', summary: 'The scripted reviewer blocked this change', fix: 'Change the code' }] }
        : { findings: [] };
    case 'decision':
      return { action: 'continue', reason: 'scripted' };
    case 'reply':
      return { text: 'ok' };
    case 'proof':
      return { items: [] as ProofItem[] };
  }
}

/** The PM's submit tool follows the request: `decidePrompt`, `intakePrompt` or `messagePrompt`. */
function pmSubmitKind(job: AgentJob, terminal: string): SubmitKind {
  const prompt = sentText.get(terminal) ?? job.prompt;
  if (prompt.includes('Call `decide`')) return 'decision';
  if (prompt.includes('`submit_brief`')) return 'brief';
  if (prompt.includes('`reply`')) return 'reply';
  return 'brief';
}

/**
 * One agent's life, as the observer reports it: launched, working, submitted, idle (§3.3, §5.5).
 * Thunks, because the submission is read when it is emitted: the follow-up that asks for it is
 * pasted into the terminal after this observer starts.
 */
function observationsFor(job: AgentJob, terminal: string, options: ScriptedOptions): Array<() => AgentObservation> {
  const app = job.agent.cli;
  return [
    () => ({ type: 'OBS_STATUS', app: 'bdc', state: 'working' }),
    () => ({ type: 'OBS_STATUS', app, state: 'working' }),
    () => ({ type: 'OBS_SUBMITTED', submission: submissionFor(job, terminal, options) }),
    () => ({ type: 'OBS_STATUS', app, state: 'idle' }),
  ];
}

function pullRequestBody(input: OpenPullRequestInput, goal: string | undefined): string {
  const lines = [
    `# ${goal === undefined || goal.trim() === '' ? `Run ${input.runId}` : goal}`,
    '',
    `Run \`${input.runId}\` on branch \`${input.runBranch}\`${input.draft ? ' (draft)' : ''}.`,
  ];
  const plan = plansByRun.get(input.runId);
  if (plan !== undefined) {
    lines.push('', '## Phases', ...plan.phases.map((phase) => `- ${phase.id}: ${phase.title}`));
  }
  lines.push('', 'Written by bdc with scripted agents.');
  return `${lines.join('\n')}\n`;
}

/** Every effect, scripted. Pass the result to `wiredRunMachine`. */
export function scriptedActors(options: ScriptedOptions = {}): WiredEffects {
  const delayMs = options.delayMs ?? 0;
  return {
    launchAgent: fromPromise<LaunchAgentOutput, LaunchAgentInput>(async ({ input }) => {
      const { key } = input.job;
      const before = scriptedLaunches.byKey.get(key);
      const reattached = before !== undefined;
      scriptedLaunches.byKey.set(key, {
        launches: (before?.launches ?? 0) + 1,
        reattached: (before?.reattached ?? 0) + (reattached ? 1 : 0),
      });
      scriptedLaunches.log.push({ key, reattached });
      return { terminal: `scripted-${key}`, reattached };
    }),

    observeAgent: fromCallback<AgentObservation, ObserveAgentInput>(({ input, sendBack }) => {
      const observations = observationsFor(input.job, input.terminal, options);
      const timers = new Set<NodeJS.Timeout>();
      let index = 0;
      let stopped = false;
      const tick = (): void => {
        if (stopped) return;
        const next = observations[index];
        index += 1;
        if (next === undefined) return;
        sendBack(next());
        if (index < observations.length) timers.add(setTimeout(tick, delayMs));
      };
      timers.add(setTimeout(tick, delayMs));
      return () => {
        stopped = true;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      };
    }),

    sendToAgent: fromPromise<void, SendToAgentInput>(async ({ input }) => {
      scriptedSends.push(input);
      if (input.text !== undefined) sentText.set(input.terminal, input.text);
    }),

    closeAgent: fromPromise<void, CloseAgentInput>(async ({ input }) => {
      scriptedCloses.push(input.terminal);
    }),

    ensureWorktree: fromPromise<EnsureWorktreeOutput, EnsureWorktreeInput>(async ({ input }) => ({
      path: `${input.root}/.worktrees/${input.branch}`,
      head: 'scripted',
    })),

    mergeBranch: fromPromise<MergeBranchOutput, MergeBranchInput>(async () => ({ merged: true, head: 'scripted' })),

    commitsSince: fromPromise<CommitsSinceOutput, CommitsSinceInput>(async () => ({ commits: [] })),

    runVerification: fromPromise<RunVerificationOutput, RunVerificationInput>(async ({ input }) => ({
      passed: true,
      steps: input.extraChecks.map((check) => ({
        phase: 'check' as const,
        name: check.name ?? check.run,
        command: check.run,
        exitCode: 0,
        durationMs: 1,
        outputTail: '',
      })),
      proofFiles: ['verify.log'],
    })),

    checkProof: fromPromise<CheckProofOutput, CheckProofInput>(async () => ({ complete: true, missing: [], invalid: [] })),

    openPullRequest: fromPromise<OpenPullRequestOutput, OpenPullRequestInput>(async ({ input }) => {
      const target = input.prTargets.find((candidate) => candidate.provider === 'file');
      const relative = target?.provider === 'file' ? target.path : '.herd/pull-request.md';
      const file = path.resolve(input.root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, pullRequestBody(input, options.goal));
      return { path: relative };
    }),
  };
}
