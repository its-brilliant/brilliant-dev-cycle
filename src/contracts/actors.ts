/**
 * Inputs and outputs of the actors the machines invoke. Machines name these actors in
 * `setup({ actors })` with implementations that throw; the daemon provides the real ones
 * (`machine.provide({ actors })`) and tests provide stubs. That keeps every machine pure.
 */
import type { AgentChoice, Finding, ProofRequirement, Role, VerificationSetup } from './domain.js';

/** Which submit tool ends the job (§3.4). The MCP server validates the submission for it. */
export type SubmitKind = 'brief' | 'reply' | 'decision' | 'spec' | 'plan' | 'task' | 'findings' | 'proof';

/** The MCP tool that ends a job of each kind (§3.4). `bdc mcp` and the agent machine's nudge both use it. */
export const SUBMIT_TOOLS: Record<SubmitKind, string> = {
  brief: 'submit_brief',
  reply: 'reply',
  decision: 'decide',
  spec: 'submit_spec',
  plan: 'submit_plan',
  task: 'report_task',
  findings: 'submit_findings',
  proof: 'submit_proof',
};

/** One agent job (§5.5). `key` is stable for the job, so a restored machine re-attaches instead of relaunching. */
export interface AgentJob {
  key: string;
  role: Role;
  agent: AgentChoice;
  cwd: string;
  prompt: string;
  submit: SubmitKind;
  timeoutMs: number;
  /** Builders, the verifier and the PM stay up for follow-ups; the rest close on done. */
  keepAlive: boolean;
  /** Labels for hc (`bdc.run`, `bdc.phase`, ...). */
  labels: Record<string, string>;
}

// ── hc / agent effects ─────────────────────────────────────────────────────────────────

/** `launchAgent`: start the agent, or re-attach to a live terminal with the same key. */
export interface LaunchAgentInput { job: AgentJob }
export interface LaunchAgentOutput { terminal: string; reattached: boolean }

/** `observeAgent` (callback actor): emits `AgentObservation` events for the terminal until stopped. */
export interface ObserveAgentInput { job: AgentJob; terminal: string }

/** `sendToAgent`: paste text into the agent (follow-ups, nudges) or press keys (prompt choices). */
export interface SendToAgentInput { terminal: string; text?: string; keys?: string[] }

/** `closeAgent`: end the agent and remove its terminal. Idempotent. */
export interface CloseAgentInput { terminal: string }

// ── git effects (§7.3) ─────────────────────────────────────────────────────────────────

/** `ensureWorktree`: create the branch from `base` (if missing) and its worktree (if missing). Idempotent. */
export interface EnsureWorktreeInput { root: string; branch: string; base: string }
export interface EnsureWorktreeOutput { path: string; head: string }

/** `mergeBranch`: merge `from` into the worktree at `into`. Fast-forward, else a merge commit; a conflict is aborted. */
export interface MergeBranchInput { into: string; from: string }
export type MergeBranchOutput = { merged: true; head: string } | { merged: false; conflicts: string[] };

/** `commitsSince`: commits on a branch after `base`, with the files each touched (fix routing, §4.4). */
export interface CommitsSinceInput { root: string; branch: string; base: string }
export interface CommitsSinceOutput { commits: Array<{ sha: string; files: string[] }> }

// ── verification and proof (§7.4, §4.4.1) ──────────────────────────────────────────────

export interface StepResult {
  phase: 'setup' | 'ready' | 'check' | 'teardown';
  name: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
}

/** `runVerification`: setup → ready → checks → teardown (always) in `worktree`, in verification slot `slot`. */
export interface RunVerificationInput {
  runId: string;
  phaseId: string;
  worktree: string;
  slot: number;
  setup: VerificationSetup | null;
  /** The phase's own `run:` checks, after the repo's checks. */
  extraChecks: Array<{ name?: string; run: string }>;
}
export interface RunVerificationOutput {
  passed: boolean;
  /** Which stage failed, when it did. */
  failedAt?: 'setup' | 'ready' | 'check';
  steps: StepResult[];
  /** Files bdc captured (logs, test reports) as proof of kind `tests` / `log`. */
  proofFiles: string[];
}

/** One proof item, from bdc (verification), the verifier (`submit_proof`) or the person (`manual`). */
export interface ProofItem {
  kind: ProofRequirement['kind'];
  shows: string;
  file?: string;
  by: 'bdc' | 'verifier' | 'person';
}

/** `checkProof`: every requirement has a valid item (file exists, right type, non-empty, report says passed). */
export interface CheckProofInput { requirements: ProofRequirement[]; items: ProofItem[] }
export interface CheckProofOutput { complete: boolean; missing: ProofRequirement[]; invalid: Array<{ item: ProofItem; why: string }> }

// ── review ─────────────────────────────────────────────────────────────────────────────

/** Resolved lens prompt (shared or project, §8). */
export interface LensPrompt { name: string; text: string; source: 'project' | 'shared' | 'default' }
export interface LensResult { lens: string; findings: Finding[] }
