/**
 * The phase machine (spec §5.3): one phase, from waiting for its deps to done.
 *
 * Every side effect is a named actor the daemon provides (src/contracts/actors.ts): `agent`
 * (the agent machine, §5.5), `ensureWorktree`, `mergeBranch`, `commitsSince`,
 * `runVerification` and `checkProof`. Child agents report AGENT_RESULT / AGENT_NEEDS_YOU to
 * this machine and take FOLLOW_UP / PROMPT_CHOICE / CLOSE from it.
 *
 * Rules this machine keeps (docs/dev/architecture.md):
 * - pure: no fs, no clock; timeouts are the role defaults of §3.3, handed to the agent job;
 * - context is JSON: arrays and plain objects only, no Map/Set/Date;
 * - restore-safe: the agent actors re-attach by `job.key`, so re-spawning a child after a
 *   restore is a re-attach, not a second agent;
 * - PAUSE only stops *new* agents from starting; running agents finish their turn.
 *
 * RETRY is not handled here: `stopped` is final for a phase and the run spawns a fresh phase
 * for a retry (§5.3).
 */
import { and, assign, enqueueActions, fromCallback, fromPromise, sendParent, setup } from 'xstate';
import type { AnyActorLogic } from 'xstate';

import type {
  AgentChoice,
  BlockOn,
  Blocker,
  Decision,
  Finding,
  Lens,
  PlanPhase,
  ProofKind,
  Severity,
  VerificationSetup,
} from '../contracts/domain.js';
import type {
  AgentJob,
  CheckProofInput,
  CheckProofOutput,
  CommitsSinceInput,
  CommitsSinceOutput,
  EnsureWorktreeInput,
  EnsureWorktreeOutput,
  MergeBranchInput,
  MergeBranchOutput,
  ProofItem,
  RunVerificationInput,
  RunVerificationOutput,
} from '../contracts/actors.js';
import type { AgentOutcome, AgentToParent, RunToPhase } from '../contracts/events.js';

// ── what a phase is given ──────────────────────────────────────────────────────────────

export interface PhaseInput {
  runId: string;
  root: string;
  runBranch: string;
  runWorktree: string;
  phase: PlanPhase;
  /** Lens name → its config and the prompt a person wrote for it (§8). */
  lenses: Record<string, Lens & { prompt: string }>;
  agents: { builder: AgentChoice; reviewer: AgentChoice; verifier: AgentChoice };
  verification: VerificationSetup | null;
  maxAttempts: number;
  /** Phases of this run that are already done (§4.4 step 1). */
  doneDeps: string[];
}

/** One task of the phase and where its builder works. */
export interface PhaseTask {
  id: string;
  branch: string;
  worktree: string;
  builderId: string;
  key: string;
  status: 'pending' | 'done' | 'failed';
  merged: boolean;
}

/** One reviewer of the current review round. */
export interface PhaseReviewer {
  lens: string;
  id: string;
  key: string;
  done: boolean;
}

/** A spawned agent child: its actor id and its job key (which is how the run names it). */
export interface PhaseChild {
  id: string;
  key: string;
}

export interface PhaseContext extends PhaseInput {
  phaseBranch: string;
  phaseWorktree: string;
  tasks: PhaseTask[];
  /** Worktrees still to create, phase branch first (§7.3). */
  ensures: Array<{ branch: string; base: string }>;
  buildersSpawned: boolean;
  /** The task whose builder is resolving a merge conflict in the phase worktree. */
  resolvingTask: string | null;
  conflictFiles: string[];
  round: number;
  reviewers: PhaseReviewer[];
  /** Lens → findings of the current round. */
  findings: Record<string, Finding[]>;
  overrides: Array<{ who: 'person' | 'pm'; lens?: string; reason: string }>;
  slot: number | null;
  proofFiles: string[];
  proofItems: ProofItem[];
  verifierDone: boolean;
  manualAsked: boolean;
  blocker: Blocker | null;
  attemptsUsed: number;
  decision: Decision | null;
  /** Task ids whose commits still have to be read to route a fix (§4.4). */
  fixProbes: string[];
  taskCommits: Record<string, string[]>;
  fixTask: string | null;
  fixSent: boolean;
  paused: boolean;
  children: PhaseChild[];
  stopReason: string | null;
}

type PhaseEvent = RunToPhase | AgentToParent;

const BUILDER_TIMEOUT_MS = 30 * 60_000;
const OTHER_TIMEOUT_MS = 15 * 60_000;

/** Proof kinds only the verifier agent can produce (§4.4.1). */
const VERIFIER_KINDS: ProofKind[] = ['screenshot', 'e2e', 'recording', 'walkthrough'];
/** Proof kinds bdc itself captures while verifying (§4.4.1). */
const BDC_KINDS: ProofKind[] = ['tests', 'log'];

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** §8: a finding blocks when its severity is at or above the lens's `block_on`; 'none' never blocks. */
export function blocks(severity: Severity, blockOn: BlockOn): boolean {
  if (blockOn === 'none') return false;
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[blockOn];
}

// ── event narrowing (setup types the event as the whole union) ─────────────────────────

const asAgentResult = (event: PhaseEvent) => event as Extract<AgentToParent, { type: 'AGENT_RESULT' }>;
const asNeedsYou = (event: PhaseEvent) => event as Extract<AgentToParent, { type: 'AGENT_NEEDS_YOU' }>;
const asDecision = (event: PhaseEvent) => event as Extract<RunToPhase, { type: 'PM_DECISION' }>;
const asOverride = (event: PhaseEvent) => event as Extract<RunToPhase, { type: 'OVERRIDE' }>;
const asPromptChoice = (event: PhaseEvent) => event as Extract<RunToPhase, { type: 'PROMPT_CHOICE' }>;
const asDepDone = (event: PhaseEvent) => event as Extract<RunToPhase, { type: 'DEP_DONE' }>;
const asSlotGranted = (event: PhaseEvent) => event as Extract<RunToPhase, { type: 'VERIFY_SLOT_GRANTED' }>;
// SAFETY: the only events passed here are `xstate.done.actor.*` from the invoke named at the call
// site, whose output type is the `T` the caller names (the actor's declared output).
const doneOutput = <T>(event: PhaseEvent) => (event as unknown as { output: T }).output;

// ── derived values ─────────────────────────────────────────────────────────────────────

function initialContext(input: PhaseInput): PhaseContext {
  const phaseBranch = `bdc/${input.runId}/${input.phase.id}`;
  const tasks: PhaseTask[] = input.phase.tasks.map((task) => ({
    id: task.id,
    branch: `${phaseBranch}/${task.id}`,
    worktree: '',
    builderId: `builder-${task.id}`,
    key: `${input.runId}/${input.phase.id}/${task.id}/builder`,
    status: 'pending',
    merged: false,
  }));
  return {
    ...input,
    phaseBranch,
    phaseWorktree: '',
    tasks,
    ensures: [
      { branch: phaseBranch, base: input.runBranch },
      ...tasks.map((task) => ({ branch: task.branch, base: phaseBranch })),
    ],
    buildersSpawned: false,
    resolvingTask: null,
    conflictFiles: [],
    round: 0,
    reviewers: [],
    findings: {},
    overrides: [],
    slot: null,
    proofFiles: [],
    proofItems: [],
    verifierDone: false,
    manualAsked: false,
    blocker: null,
    attemptsUsed: 0,
    decision: null,
    fixProbes: [],
    taskCommits: {},
    fixTask: null,
    fixSent: false,
    paused: false,
    children: [],
    stopReason: null,
  };
}

function taskOf(context: PhaseContext, id: string | null): PhaseTask | undefined {
  return id === null ? undefined : context.tasks.find((task) => task.id === id);
}

function childOf(context: PhaseContext, id: string): PhaseChild | undefined {
  return context.children.find((child) => child.id === id);
}

function needsVerifier(context: PhaseContext): boolean {
  return context.phase.proof.some((requirement) => VERIFIER_KINDS.includes(requirement.kind));
}

function overridden(context: PhaseContext, lens: string): boolean {
  // An override without a lens is the person saying "go on with this phase", so it covers every lens.
  return context.overrides.some((override) => override.lens === undefined || override.lens === lens);
}

/** The lenses of this round whose findings block and were not overridden. */
function blockingLenses(context: PhaseContext): string[] {
  return Object.keys(context.findings).filter((lens) => {
    const config = context.lenses[lens];
    if (!config) return false;
    if (overridden(context, lens)) return false;
    return (context.findings[lens] ?? []).some((finding) => blocks(finding.severity, config.block_on));
  });
}

function hasAttemptsLeft(context: PhaseContext): boolean {
  return context.attemptsUsed < context.maxAttempts - 1;
}

/**
 * The worktree still to create, or — once every worktree exists — the phase branch again, so a
 * restored machine re-runs an idempotent `ensureWorktree` instead of nothing (§5.7).
 */
function ensureInput(context: PhaseContext): EnsureWorktreeInput {
  const next = context.ensures[0];
  return next
    ? { root: context.root, branch: next.branch, base: next.base }
    : { root: context.root, branch: context.phaseBranch, base: context.runBranch };
}

/** The next task branch to merge into the phase worktree, in plan order. */
function mergeInput(context: PhaseContext): MergeBranchInput {
  const task = context.tasks.find((candidate) => !candidate.merged);
  return { into: context.phaseWorktree, from: task ? task.branch : context.phaseBranch };
}

/** The task branch whose commits are read next to route a fix. */
function commitsSinceInput(context: PhaseContext): CommitsSinceInput {
  const task = taskOf(context, context.fixProbes[0] ?? null);
  return { root: context.root, branch: task ? task.branch : context.phaseBranch, base: context.phaseBranch };
}

function verificationInput(context: PhaseContext): RunVerificationInput {
  return {
    runId: context.runId,
    phaseId: context.phase.id,
    worktree: context.phaseWorktree,
    slot: context.slot ?? 0,
    setup: context.verification,
    extraChecks: context.phase.checks.flatMap((check) =>
      'run' in check ? [{ ...(check.name === undefined ? {} : { name: check.name }), run: check.run }] : [],
    ),
  };
}

function labels(context: PhaseContext, role: string, key: string, task?: string): Record<string, string> {
  return {
    'bdc.run': context.runId,
    'bdc.phase': context.phase.id,
    ...(task === undefined ? {} : { 'bdc.task': task }),
    'bdc.role': role,
    'bdc.key': key,
  };
}

function builderJob(context: PhaseContext, task: PhaseTask): AgentJob {
  const planned = context.phase.tasks.find((candidate) => candidate.id === task.id);
  const paths = planned && planned.paths.length > 0 ? ` Expected paths: ${planned.paths.join(', ')}.` : '';
  return {
    key: task.key,
    role: 'builder',
    agent: context.agents.builder,
    cwd: task.worktree,
    prompt: `Phase "${context.phase.title}" (${context.phase.id}), task ${task.id}: ${planned?.title ?? task.id}.${paths} Work on branch ${task.branch} in your worktree and commit there.`,
    submit: 'task',
    timeoutMs: BUILDER_TIMEOUT_MS,
    keepAlive: true,
    labels: labels(context, 'builder', task.key, task.id),
  };
}

function reviewerJob(context: PhaseContext, reviewer: PhaseReviewer): AgentJob {
  const lens = context.lenses[reviewer.lens];
  return {
    key: reviewer.key,
    role: 'reviewer',
    agent: lens?.agent ?? context.agents.reviewer,
    cwd: context.phaseWorktree,
    prompt: lens?.prompt ?? '',
    submit: 'findings',
    timeoutMs: OTHER_TIMEOUT_MS,
    keepAlive: false,
    labels: labels(context, 'reviewer', reviewer.key),
  };
}

function verifierJob(context: PhaseContext): AgentJob {
  const key = `${context.runId}/${context.phase.id}/verifier`;
  const wanted = context.phase.proof.filter((requirement) => VERIFIER_KINDS.includes(requirement.kind));
  return {
    key,
    role: 'verifier',
    agent: context.agents.verifier,
    cwd: context.phaseWorktree,
    prompt: `Produce the proof this phase needs, in ${context.phaseWorktree}: ${wanted
      .map((requirement) => `${requirement.kind}${requirement.shows ? ` — ${requirement.shows}` : ''}`)
      .join('; ')}. Submit each item with submit_proof.`,
    submit: 'proof',
    timeoutMs: OTHER_TIMEOUT_MS,
    keepAlive: true,
    labels: labels(context, 'verifier', key),
  };
}

function agentFailure(kind: Blocker['kind'], what: string, outcome: AgentOutcome): Blocker {
  const detail = 'detail' in outcome ? outcome.detail : '';
  return { kind, summary: `${what} did not finish (${outcome.status})`, evidence: detail === '' ? [] : [detail] };
}

function conflictPrompt(context: PhaseContext, task: PhaseTask): string {
  const files = context.conflictFiles.length > 0 ? ` Conflicting files: ${context.conflictFiles.join(', ')}.` : '';
  return `Your task branch ${task.branch} conflicts with the phase branch. Resolve it in the phase worktree ${context.phaseWorktree}, commit the merge there, and report done.${files}`;
}

// ── the machine ───────────────────────────────────────────────────────────────────────

export const phaseMachine = setup({
  types: {
    context: {} as PhaseContext,
    events: {} as PhaseEvent,
    input: {} as PhaseInput,
  },
  actors: {
    // The daemon supplies the agent machine (§5.5); tests supply a stub that answers on command.
    // SAFETY: the slot takes any actor logic, so the daemon can hand in `agentMachine` and tests a
    // stub machine; this default only exists to fail loudly when nobody provided one.
    agent: fromCallback<AgentToParent, AgentJob>(() => {
      throw new Error('agent not provided');
    }) as AnyActorLogic,
    ensureWorktree: fromPromise<EnsureWorktreeOutput, EnsureWorktreeInput>(async () => {
      throw new Error('ensureWorktree not provided');
    }),
    mergeBranch: fromPromise<MergeBranchOutput, MergeBranchInput>(async () => {
      throw new Error('mergeBranch not provided');
    }),
    commitsSince: fromPromise<CommitsSinceOutput, CommitsSinceInput>(async () => {
      throw new Error('commitsSince not provided');
    }),
    runVerification: fromPromise<RunVerificationOutput, RunVerificationInput>(async () => {
      throw new Error('runVerification not provided');
    }),
    checkProof: fromPromise<CheckProofOutput, CheckProofInput>(async () => {
      throw new Error('checkProof not provided');
    }),
  },
  guards: {
    depsDone: ({ context }) => context.phase.deps.every((dep) => context.doneDeps.includes(dep)),
    // The guards below run before the transition's actions, so they ask about the context as it
    // is on entry to the transition: "one more item after this one".
    moreEnsuresAfterThis: ({ context }) => context.ensures.length > 1,
    buildersPending: ({ context }) => !context.paused && context.ensures.length === 0 && !context.buildersSpawned,
    buildersDone: ({ context }) => context.tasks.every((task) => task.status === 'done'),
    builderFailed: ({ event }) => asAgentResult(event).outcome.status !== 'done',
    mergeConflicted: ({ event }) => !doneOutput<MergeBranchOutput>(event).merged,
    moreMergesAfterThis: ({ context }) => context.tasks.filter((task) => !task.merged).length > 1,
    resolverFailed: ({ context, event }) => {
      const task = taskOf(context, context.resolvingTask);
      const result = asAgentResult(event);
      return task !== undefined && task.key === result.key && result.outcome.status !== 'done';
    },
    fromResolver: ({ context, event }) => {
      const task = taskOf(context, context.resolvingTask);
      return task !== undefined && task.key === asAgentResult(event).key;
    },
    reviewersPending: ({ context }) =>
      !context.paused && context.reviewers.some((reviewer) => !reviewer.done && childOf(context, reviewer.id) === undefined),
    reviewFailed: ({ event }) => asAgentResult(event).outcome.status !== 'done',
    reviewComplete: ({ context }) => context.reviewers.every((reviewer) => reviewer.done),
    blockingFindings: ({ context }) =>
      context.reviewers.every((reviewer) => reviewer.done) && blockingLenses(context).length > 0,
    checksPassed: ({ event }) => doneOutput<RunVerificationOutput>(event).passed,
    failedAtSetup: ({ event }) => {
      const failedAt = doneOutput<RunVerificationOutput>(event).failedAt;
      return failedAt === 'setup' || failedAt === 'ready';
    },
    verifierPending: ({ context }) =>
      !context.paused && needsVerifier(context) && childOf(context, 'verifier') === undefined,
    verifierFailed: ({ event }) => asAgentResult(event).outcome.status !== 'done',
    proofComplete: ({ event }) => doneOutput<CheckProofOutput>(event).complete,
    // checkProof also runs before a verifier has reported; that answer is ignored (see `proving`).
    proofAwaitingVerifier: ({ context }) => needsVerifier(context) && !context.verifierDone,
    attemptsLeft: ({ context }) => hasAttemptsLeft(context),
    isFixDecision: ({ event }) => asDecision(event).decision.action === 'fix',
    fixAllowed: and(['isFixDecision', 'attemptsLeft']),
    isContinue: ({ event }) => asDecision(event).decision.action === 'continue',
    isStop: ({ event }) => asDecision(event).decision.action === 'stop',
    moreFixProbesAfterThis: ({ context }) => context.fixProbes.length > 1,
    fixBuilderReady: ({ context }) => !context.paused && !context.fixSent && context.fixTask !== null,
    runMergeConflicted: ({ event }) => !doneOutput<MergeBranchOutput>(event).merged,
    blockedInReview: ({ context }) => context.blocker?.kind === 'review',
    blockedInVerify: ({ context }) =>
      context.blocker !== null && ['verify', 'verify-setup', 'proof'].includes(context.blocker.kind),
  },
  actions: {
    // ── waiting ───────────────────────────────────────────────────────────────────────
    addDep: assign({
      doneDeps: ({ context, event }) => {
        const phaseId = asDepDone(event).phaseId;
        return context.doneDeps.includes(phaseId) ? context.doneDeps : [...context.doneDeps, phaseId];
      },
    }),

    // ── building ──────────────────────────────────────────────────────────────────────
    recordEnsure: assign({
      ensures: ({ context }) => context.ensures.slice(1),
      phaseWorktree: ({ context, event }) => {
        const next = context.ensures[0];
        return next?.branch === context.phaseBranch ? doneOutput<EnsureWorktreeOutput>(event).path : context.phaseWorktree;
      },
      tasks: ({ context, event }) => {
        const next = context.ensures[0];
        if (next === undefined) return context.tasks;
        const path = doneOutput<EnsureWorktreeOutput>(event).path;
        return context.tasks.map((task) => (task.branch === next.branch ? { ...task, worktree: path } : task));
      },
    }),
    spawnBuilders: assign({
      children: ({ context, spawn }) => {
        const children = [...context.children];
        for (const task of context.tasks) {
          if (children.some((child) => child.id === task.builderId)) continue;
          spawn('agent', { id: task.builderId, input: builderJob(context, task) });
          children.push({ id: task.builderId, key: task.key });
        }
        return children;
      },
      buildersSpawned: () => true,
    }),
    recordBuilderResult: assign({
      tasks: ({ context, event }) => {
        const result = asAgentResult(event);
        const task = context.tasks.find((candidate) => candidate.key === result.key);
        if (task === undefined) return context.tasks;
        const status = result.outcome.status === 'done' ? 'done' : 'failed';
        return context.tasks.map((candidate) => (candidate.id === task.id ? { ...candidate, status } : candidate));
      },
    }),
    blockOnBuild: assign({
      blocker: ({ context, event }) => {
        const result = asAgentResult(event);
        const task = context.tasks.find((candidate) => candidate.key === result.key);
        return agentFailure('build', `the ${task?.id ?? 'unknown'} builder`, result.outcome);
      },
    }),

    // ── merging ───────────────────────────────────────────────────────────────────────
    recordMerge: assign({
      tasks: ({ context }) => {
        const next = context.tasks.find((task) => !task.merged);
        if (next === undefined) return context.tasks;
        return context.tasks.map((task) => (task.id === next.id ? { ...task, merged: true } : task));
      },
    }),
    recordConflict: assign({
      conflictFiles: ({ event }) => {
        const output = doneOutput<MergeBranchOutput>(event);
        return output.merged ? [] : output.conflicts;
      },
      // Merging is sequential, so the builder that has to resolve the conflict is the one whose
      // task branch just failed to merge (§7.3).
      resolvingTask: ({ context }) => context.tasks.find((task) => !task.merged)?.id ?? null,
    }),
    // The phase branch itself could not be merged into the run branch, so no builder owns the fix.
    blockOnConflict: assign({
      blocker: ({ context, event }) => {
        const output = doneOutput<MergeBranchOutput>(event);
        return {
          kind: 'conflict',
          summary: `merging ${context.phaseBranch} into ${context.runBranch} conflicts`,
          evidence: output.merged ? [] : output.conflicts,
        };
      },
    }),
    blockOnResolverFailure: assign({
      blocker: ({ event }) => agentFailure('conflict', 'the resolving builder', asAgentResult(event).outcome),
    }),
    markResolved: assign({ resolvingTask: () => null, conflictFiles: () => [] }),
    sendResolveFollowUp: enqueueActions(({ context, enqueue }) => {
      const task = taskOf(context, context.resolvingTask);
      if (task === undefined || childOf(context, task.builderId) === undefined) return;
      enqueue.sendTo(task.builderId, { type: 'FOLLOW_UP', prompt: conflictPrompt(context, task) });
    }),

    // ── reviewing ─────────────────────────────────────────────────────────────────────
    planReviewers: assign(({ context }) => {
      const round = context.round + 1;
      const reviewers: PhaseReviewer[] = Object.entries(context.lenses)
        .filter(([, lens]) => lens.runs !== 'final-only')
        .map(([lens]) => ({
          lens,
          id: `reviewer-${lens}-${round}`,
          key: `${context.runId}/${context.phase.id}/review-${lens}-${round}`,
          done: false,
        }));
      return { round, reviewers, findings: {} };
    }),
    spawnReviewers: assign({
      children: ({ context, spawn }) => {
        const children = [...context.children];
        for (const reviewer of context.reviewers) {
          if (reviewer.done || children.some((child) => child.id === reviewer.id)) continue;
          spawn('agent', { id: reviewer.id, input: reviewerJob(context, reviewer) });
          children.push({ id: reviewer.id, key: reviewer.key });
        }
        return children;
      },
    }),
    recordReviewResult: assign({
      reviewers: ({ context, event }) => {
        const key = asAgentResult(event).key;
        return context.reviewers.map((reviewer) => (reviewer.key === key ? { ...reviewer, done: true } : reviewer));
      },
      findings: ({ context, event }) => {
        const result = asAgentResult(event);
        const reviewer = context.reviewers.find((candidate) => candidate.key === result.key);
        if (reviewer === undefined || result.outcome.status !== 'done') return context.findings;
        const submission = result.outcome.submission as { findings?: Finding[] } | null | undefined;
        return { ...context.findings, [reviewer.lens]: submission?.findings ?? [] };
      },
    }),
    sendFindings: sendParent(({ context, event }) => {
      const result = asAgentResult(event);
      const reviewer = context.reviewers.find((candidate) => candidate.key === result.key);
      const submission = result.outcome.status === 'done'
        ? (result.outcome.submission as { findings?: Finding[] } | null | undefined)
        : undefined;
      return {
        type: 'PHASE_FINDINGS' as const,
        phaseId: context.phase.id,
        lens: reviewer?.lens ?? '',
        findings: submission?.findings ?? [],
      };
    }),
    recordReviewFailure: assign({
      reviewers: ({ context, event }) => {
        const key = asAgentResult(event).key;
        return context.reviewers.map((reviewer) => (reviewer.key === key ? { ...reviewer, done: true } : reviewer));
      },
      blocker: ({ context, event }) => {
        const key = asAgentResult(event).key;
        const reviewer = context.reviewers.find((candidate) => candidate.key === key);
        return agentFailure('review', `the ${reviewer?.lens ?? 'unknown'} reviewer`, asAgentResult(event).outcome);
      },
    }),
    recordOverride: assign({
      overrides: ({ context, event }) => {
        const override = asOverride(event);
        return [
          ...context.overrides,
          { who: override.who, ...(override.lens === undefined ? {} : { lens: override.lens }), reason: override.reason },
        ];
      },
    }),
    blockOnReview: assign({
      blocker: ({ context }) => {
        const lenses = blockingLenses(context);
        const evidence = lenses.flatMap((lens) => {
          const config = context.lenses[lens];
          return (context.findings[lens] ?? [])
            .filter((finding) => config !== undefined && blocks(finding.severity, config.block_on))
            .map((finding) => `${lens}: ${finding.severity} ${finding.summary}`);
        });
        return {
          kind: 'review',
          summary: `findings block the phase from ${lenses.join(', ')}`,
          evidence,
        };
      },
    }),

    // ── verifying ─────────────────────────────────────────────────────────────────────
    recordSlot: assign({ slot: ({ event }) => asSlotGranted(event).slot }),
    recordVerification: assign({
      proofFiles: ({ event }) => doneOutput<RunVerificationOutput>(event).proofFiles,
    }),
    blockOnVerifySetup: assign({
      blocker: ({ event }) => verifyBlocker('verify-setup', doneOutput<RunVerificationOutput>(event)),
    }),
    blockOnVerify: assign({
      blocker: ({ event }) => verifyBlocker('verify', doneOutput<RunVerificationOutput>(event)),
    }),

    // ── proving ───────────────────────────────────────────────────────────────────────
    // Proof that bdc captured itself (test reports, logs) is rebuilt from the verification run, so
    // this action is idempotent when `proving` is re-entered after the verifier reports.
    collectBdcProof: assign({
      proofItems: ({ context }) => {
        const fromVerifier = context.proofItems.filter((item) => item.by !== 'bdc');
        const files = [...context.proofFiles];
        const fromBdc: ProofItem[] = [];
        for (const requirement of context.phase.proof) {
          if (!BDC_KINDS.includes(requirement.kind)) continue;
          const file = files.shift();
          fromBdc.push(
            file === undefined
              ? { kind: requirement.kind, shows: requirement.shows, by: 'bdc' }
              : { kind: requirement.kind, shows: requirement.shows, file, by: 'bdc' },
          );
        }
        return [...fromBdc, ...fromVerifier];
      },
    }),
    // Only a person can judge `manual` proof, and only the PM asks the person (§3.4), so the phase
    // asks the PM for it right away. If the confirmation never arrives as an item, checkProof sends
    // the phase to `deciding` with the same blocker, where the PM can ask or continue.
    askManualProof: enqueueActions(({ context, enqueue }) => {
      if (context.manualAsked) return;
      const manual = context.phase.proof.filter((requirement) => requirement.kind === 'manual');
      if (manual.length === 0) return;
      enqueue.assign({ manualAsked: () => true });
      enqueue.sendParent({
        type: 'PHASE_NEEDS_PM' as const,
        phaseId: context.phase.id,
        blocker: {
          kind: 'proof' as const,
          summary: `a person has to confirm: ${manual.map((requirement) => requirement.shows || 'manual proof').join('; ')}`,
          evidence: manual.map((requirement) => `manual: ${requirement.shows}`),
        },
        attemptsUsed: context.attemptsUsed,
        attemptsMax: context.maxAttempts,
      });
    }),
    spawnVerifier: assign({
      children: ({ context, spawn }) => {
        if (childOf(context, 'verifier') !== undefined) return context.children;
        spawn('agent', { id: 'verifier', input: verifierJob(context) });
        return [...context.children, { id: 'verifier', key: `${context.runId}/${context.phase.id}/verifier` }];
      },
    }),
    recordVerifierResult: assign({
      verifierDone: () => true,
      proofItems: ({ context, event }) => {
        const outcome = asAgentResult(event).outcome;
        const submission = outcome.status === 'done' ? (outcome.submission as { items?: ProofItem[] } | null | undefined) : undefined;
        const fromBdc = context.proofItems.filter((item) => item.by === 'bdc');
        return [...fromBdc, ...(submission?.items ?? [])];
      },
    }),
    blockOnProofFailure: assign({
      blocker: ({ event }) => agentFailure('proof', 'the verifier', asAgentResult(event).outcome),
    }),
    blockOnProof: assign({
      blocker: ({ event }) => {
        const output = doneOutput<CheckProofOutput>(event);
        const evidence = [
          ...output.missing.map((requirement) => `${requirement.kind} missing${requirement.shows ? `: ${requirement.shows}` : ''}`),
          ...output.invalid.map((entry) => `${entry.item.kind} invalid: ${entry.why}`),
        ];
        return {
          kind: 'proof',
          summary: `proof is incomplete: ${evidence[0] ?? 'see evidence'}`,
          evidence,
        };
      },
    }),

    // ── deciding / awaitingYou ────────────────────────────────────────────────────────
    askPm: sendParent(({ context }) => ({
      type: 'PHASE_NEEDS_PM' as const,
      phaseId: context.phase.id,
      blocker: context.blocker ?? { kind: 'build' as const, summary: 'the phase is blocked', evidence: [] },
      attemptsUsed: context.attemptsUsed,
      attemptsMax: context.maxAttempts,
    })),
    recordDecision: assign({ decision: ({ event }) => asDecision(event).decision }),
    countAttempt: assign({ attemptsUsed: ({ context }) => context.attemptsUsed + 1 }),
    askAgainNoFixLeft: sendParent(({ context }) => ({
      type: 'PHASE_NEEDS_PM' as const,
      phaseId: context.phase.id,
      blocker: {
        kind: context.blocker?.kind ?? ('build' as const),
        summary: `no fix attempts left (${context.attemptsUsed} of ${context.maxAttempts}). ${context.blocker?.summary ?? ''}`.trim(),
        evidence: context.blocker?.evidence ?? [],
      },
      attemptsUsed: context.attemptsUsed,
      attemptsMax: context.maxAttempts,
    })),
    recordContinue: assign({
      overrides: ({ context, event }) => {
        const decision = asDecision(event).decision;
        return [...context.overrides, { who: 'pm' as const, reason: decision.reason }];
      },
    }),
    recordStop: assign({
      stopReason: ({ event }) => {
        const decision = asDecision(event).decision;
        return decision.action === 'stop' ? decision.reason : 'stopped';
      },
    }),

    // ── fixing ────────────────────────────────────────────────────────────────────────
    prepareFix: assign({
      fixTask: ({ event }) => {
        const decision = asDecision(event).decision;
        return decision.action === 'fix' && decision.builder !== undefined ? decision.builder : null;
      },
      // The PM can name the builder; when it does not, the task branches are read (§4.4).
      fixProbes: ({ context, event }) => {
        const decision = asDecision(event).decision;
        return decision.action === 'fix' && decision.builder !== undefined ? [] : context.tasks.map((task) => task.id);
      },
      fixSent: () => false,
      taskCommits: () => ({}),
    }),
    recordTaskCommits: assign({
      fixProbes: ({ context }) => context.fixProbes.slice(1),
      taskCommits: ({ context, event }) => {
        const taskId = context.fixProbes[0];
        if (taskId === undefined) return context.taskCommits;
        const files = doneOutput<CommitsSinceOutput>(event).commits.flatMap((commit) => commit.files);
        return { ...context.taskCommits, [taskId]: files };
      },
    }),
    /** The fix is a new commit on the builder's task branch: that branch merges again (§7.3). */
    reopenFixedTask: assign({
      tasks: ({ context }) =>
        context.tasks.map((task) => (task.id === context.fixTask ? { ...task, merged: false } : task)),
    }),
    chooseFixBuilder: assign({
      fixTask: ({ context }) => {
        if (context.fixTask !== null) return context.fixTask;
        const text = [context.blocker?.summary ?? '', ...(context.blocker?.evidence ?? [])].join('\n');
        const match = context.tasks.find((task) => (context.taskCommits[task.id] ?? []).some((file) => text.includes(file)));
        return match?.id ?? context.tasks[0]?.id ?? null;
      },
    }),
    sendFixFollowUp: enqueueActions(({ context, enqueue }) => {
      const task = taskOf(context, context.fixTask);
      const decision = context.decision;
      if (task === undefined || decision === null || decision.action !== 'fix') return;
      if (childOf(context, task.builderId) === undefined) return;
      enqueue.assign({ fixSent: () => true });
      enqueue.sendTo(task.builderId, { type: 'FOLLOW_UP', prompt: decision.instructions });
    }),

    // ── closing out ───────────────────────────────────────────────────────────────────
    closeChildren: enqueueActions(({ context, enqueue }) => {
      for (const child of context.children) enqueue.sendTo(child.id, { type: 'CLOSE' });
    }),
    sendDone: sendParent(({ context }) => ({ type: 'PHASE_DONE' as const, phaseId: context.phase.id })),
    sendStopped: sendParent(({ context }) => ({
      type: 'PHASE_STOPPED' as const,
      phaseId: context.phase.id,
      reason: context.stopReason ?? 'stopped',
    })),

    // ── run ↔ phase plumbing ──────────────────────────────────────────────────────────
    pause: assign({ paused: () => true }),
    resume: assign({ paused: () => false }),
    forwardNeedsYou: sendParent(({ event }) => {
      const needsYou = asNeedsYou(event);
      return { type: 'AGENT_NEEDS_YOU' as const, key: needsYou.key, prompt: needsYou.prompt, choices: needsYou.choices };
    }),
    forwardPromptChoice: enqueueActions(({ context, event, enqueue }) => {
      const choice = asPromptChoice(event);
      const child = context.children.find((candidate) => candidate.key === choice.agentKey);
      if (child === undefined) return;
      enqueue.sendTo(child.id, { type: 'PROMPT_CHOICE', choice: choice.choice });
    }),
  },
}).createMachine({
  id: 'phase',
  initial: 'waiting',
  context: ({ input }) => initialContext(input),
  // Accepted everywhere except the final states; PAUSE stops new agents, RESUME carries on.
  on: {
    PAUSE: { actions: 'pause' },
    RESUME: { actions: 'resume' },
    CANCEL: { target: '.cancelled' },
    OVERRIDE: { actions: 'recordOverride' },
    AGENT_NEEDS_YOU: { actions: 'forwardNeedsYou' },
    PROMPT_CHOICE: { actions: 'forwardPromptChoice' },
  },
  states: {
    waiting: {
      on: { DEP_DONE: { actions: 'addDep' } },
      always: [{ guard: 'depsDone', target: 'building' }],
    },

    building: {
      invoke: {
        id: 'ensureWorktree',
        src: 'ensureWorktree',
        input: ({ context }) => ensureInput(context),
        onDone: [
          { guard: 'moreEnsuresAfterThis', target: 'building', reenter: true, actions: 'recordEnsure' },
          { actions: 'recordEnsure' },
        ],
      },
      always: [
        { guard: 'buildersPending', actions: 'spawnBuilders' },
        { guard: 'buildersDone', target: 'merging' },
      ],
      on: {
        AGENT_RESULT: [
          { guard: 'builderFailed', target: 'deciding', actions: ['recordBuilderResult', 'blockOnBuild'] },
          { actions: 'recordBuilderResult' },
        ],
      },
    },

    merging: {
      invoke: {
        id: 'mergeBranch',
        src: 'mergeBranch',
        input: ({ context }) => mergeInput(context),
        onDone: [
          { guard: 'mergeConflicted', target: 'resolving', actions: 'recordConflict' },
          { guard: 'moreMergesAfterThis', target: 'merging', reenter: true, actions: 'recordMerge' },
          { target: 'reviewing', actions: 'recordMerge' },
        ],
      },
    },

    resolving: {
      entry: 'sendResolveFollowUp',
      on: {
        AGENT_RESULT: [
          { guard: 'resolverFailed', target: 'deciding', actions: 'blockOnResolverFailure' },
          { guard: 'fromResolver', target: 'merging', actions: 'markResolved' },
        ],
      },
    },

    reviewing: {
      entry: 'planReviewers',
      always: [
        { guard: 'reviewersPending', actions: 'spawnReviewers' },
        { guard: 'blockingFindings', target: 'deciding', actions: 'blockOnReview' },
        { guard: 'reviewComplete', target: 'queuedForVerify' },
      ],
      on: {
        AGENT_RESULT: [
          { guard: 'reviewFailed', target: 'deciding', actions: 'recordReviewFailure' },
          { actions: ['recordReviewResult', 'sendFindings'] },
        ],
      },
    },

    queuedForVerify: {
      entry: sendParent(({ context }) => ({ type: 'PHASE_VERIFY_SLOT_REQUEST' as const, phaseId: context.phase.id })),
      on: { VERIFY_SLOT_GRANTED: { target: 'verifying', actions: 'recordSlot' } },
    },

    verifying: {
      // §5.3: the slot is released on the way out, pass, fail or cancel.
      exit: sendParent(({ context }) => ({ type: 'PHASE_VERIFY_SLOT_RELEASE' as const, phaseId: context.phase.id })),
      invoke: {
        id: 'runVerification',
        src: 'runVerification',
        input: ({ context }) => verificationInput(context),
        onDone: [
          { guard: 'checksPassed', target: 'proving', actions: 'recordVerification' },
          { guard: 'failedAtSetup', target: 'deciding', actions: ['recordVerification', 'blockOnVerifySetup'] },
          { target: 'deciding', actions: ['recordVerification', 'blockOnVerify'] },
        ],
      },
    },

    proving: {
      entry: ['collectBdcProof', 'askManualProof'],
      invoke: {
        id: 'checkProof',
        src: 'checkProof',
        input: ({ context }) => ({ requirements: context.phase.proof, items: context.proofItems }),
        onDone: [
          { guard: 'proofComplete', target: 'passed' },
          // The verifier has not reported yet: its answer will be checked after it does.
          { guard: 'proofAwaitingVerifier' },
          { target: 'deciding', actions: 'blockOnProof' },
        ],
      },
      always: [{ guard: 'verifierPending', actions: 'spawnVerifier' }],
      on: {
        AGENT_RESULT: [
          { guard: 'verifierFailed', target: 'deciding', actions: ['recordVerifierResult', 'blockOnProofFailure'] },
          // Re-enter so checkProof sees the verifier's items as well.
          { target: 'proving', reenter: true, actions: 'recordVerifierResult' },
        ],
      },
    },

    deciding: {
      entry: 'askPm',
      on: {
        PM_ASKING: { target: 'awaitingYou' },
        PM_DECISION: [
          { guard: 'fixAllowed', target: 'fixing', actions: ['recordDecision', 'countAttempt', 'prepareFix'] },
          { guard: 'isFixDecision', actions: 'askAgainNoFixLeft' },
          { guard: 'isContinue', target: 'continuing', actions: ['recordDecision', 'recordContinue'] },
          { guard: 'isStop', target: 'stopped', actions: ['recordDecision', 'recordStop'] },
        ],
      },
    },

    awaitingYou: {
      on: {
        // A PM decision means the same thing here as in `deciding`.
        PM_DECISION: [
          { guard: 'fixAllowed', target: 'fixing', actions: ['recordDecision', 'countAttempt', 'prepareFix'] },
          { guard: 'isFixDecision', actions: 'askAgainNoFixLeft' },
          { guard: 'isContinue', target: 'continuing', actions: ['recordDecision', 'recordContinue'] },
          { guard: 'isStop', target: 'stopped', actions: ['recordDecision', 'recordStop'] },
        ],
      },
    },

    fixing: {
      invoke: {
        id: 'commitsSince',
        src: 'commitsSince',
        input: ({ context }) => commitsSinceInput(context),
        onDone: [
          { guard: 'moreFixProbesAfterThis', target: 'fixing', reenter: true, actions: ['recordTaskCommits', 'chooseFixBuilder'] },
          { actions: ['recordTaskCommits', 'chooseFixBuilder'] },
        ],
      },
      // Once the probes have named a builder (or the PM named one itself), the instructions go in.
      always: [{ guard: 'fixBuilderReady', actions: 'sendFixFollowUp' }],
      on: {
        AGENT_RESULT: [
          { guard: 'builderFailed', target: 'deciding', actions: ['recordBuilderResult', 'blockOnBuild'] },
          { target: 'merging', actions: ['recordBuilderResult', 'reopenFixedTask'] },
        ],
      },
    },

    continuing: {
      always: [
        { guard: 'blockedInReview', target: 'queuedForVerify' },
        { guard: 'blockedInVerify', target: 'passed' },
        // A PM that continues a build or conflict blocker skips the fix: merge what is there.
        { target: 'merging' },
      ],
    },

    passed: {
      invoke: {
        id: 'mergePhaseBranch',
        src: 'mergeBranch',
        input: ({ context }) => ({ into: context.runWorktree, from: context.phaseBranch }),
        onDone: [
          { guard: 'runMergeConflicted', target: 'deciding', actions: 'blockOnConflict' },
          { target: 'done', actions: ['closeChildren', 'sendDone'] },
        ],
      },
    },

    stopped: {
      entry: ['closeChildren', 'sendStopped'],
      type: 'final',
    },

    done: { type: 'final' },

    cancelled: {
      entry: 'closeChildren',
      type: 'final',
    },
  },
});

function verifyBlocker(kind: 'verify' | 'verify-setup', output: RunVerificationOutput): Blocker {
  const failed = output.steps.filter((step) => step.exitCode !== 0);
  return {
    kind,
    summary: `verification failed at ${output.failedAt ?? 'check'}`,
    evidence: failed.map((step) => `${step.phase} ${step.name}: exit ${step.exitCode ?? 'none'}\n${step.outputTail}`),
  };
}
