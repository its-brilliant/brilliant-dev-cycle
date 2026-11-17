/**
 * The one place the machines are wired together (spec §5.1, §5.7). Every side effect is a named
 * actor the machines declare; this module supplies them from an `effects` object, so slice 1 runs
 * the scripted effects and slice 2 the real ones without touching a machine.
 *
 * The tree is: run → (pm → agent), (phase → agent), agent, openPullRequest.
 */
import type { CallbackActorLogic, PromiseActorLogic } from 'xstate';
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
  RunVerificationInput,
  RunVerificationOutput,
  SendToAgentInput,
} from '../contracts/actors.js';
import type { AgentObservation } from '../contracts/events.js';
import { agentMachine } from '../machines/agent.js';
import { phaseMachine } from '../machines/phase.js';
import { pmMachine } from '../machines/pm.js';
import { runMachine, type OpenPullRequestInput, type OpenPullRequestOutput } from '../machines/run.js';

/** Written into `machine.json`; a snapshot from another version is not restored (§5.7). */
export const MACHINE_VERSION = 1;

/**
 * Every actor the machines invoke, by the name the machine declares it under. Real effects in
 * slice 2 implement the same shape.
 */
export interface WiredEffects {
  launchAgent: PromiseActorLogic<LaunchAgentOutput, LaunchAgentInput>;
  observeAgent: CallbackActorLogic<AgentObservation, ObserveAgentInput>;
  sendToAgent: PromiseActorLogic<void, SendToAgentInput>;
  closeAgent: PromiseActorLogic<void, CloseAgentInput>;
  ensureWorktree: PromiseActorLogic<EnsureWorktreeOutput, EnsureWorktreeInput>;
  mergeBranch: PromiseActorLogic<MergeBranchOutput, MergeBranchInput>;
  commitsSince: PromiseActorLogic<CommitsSinceOutput, CommitsSinceInput>;
  runVerification: PromiseActorLogic<RunVerificationOutput, RunVerificationInput>;
  checkProof: PromiseActorLogic<CheckProofOutput, CheckProofInput>;
  openPullRequest: PromiseActorLogic<OpenPullRequestOutput, OpenPullRequestInput>;
}

/** The run machine with every child machine and every effect provided. One per run. */
export function wiredRunMachine(effects: WiredEffects) {
  const agent = agentMachine.provide({
    actors: {
      launchAgent: effects.launchAgent,
      observeAgent: effects.observeAgent,
      sendToAgent: effects.sendToAgent,
      closeAgent: effects.closeAgent,
    },
  });
  const phase = phaseMachine.provide({
    actors: {
      agent,
      ensureWorktree: effects.ensureWorktree,
      mergeBranch: effects.mergeBranch,
      commitsSince: effects.commitsSince,
      runVerification: effects.runVerification,
      checkProof: effects.checkProof,
    },
  });
  return runMachine.provide({
    actors: {
      ensureWorktree: effects.ensureWorktree,
      pm: pmMachine.provide({ actors: { agent } }),
      phase,
      agent,
      openPullRequest: effects.openPullRequest,
    },
  });
}
