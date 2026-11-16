/**
 * The projection (spec §7.2): one run snapshot → the flat, UI-ready `view.json`.
 *
 * This is the only place that turns machine state into words. Rules it keeps:
 * - §9.1 rule 4: `stageWords` and `phases[].words` are for people — no state ids, no camelCase, no
 *   file paths. Machines keep ids; this module says them.
 * - it reads the run context and its phase children's snapshots and nothing else: no files, no clock.
 * - it does not validate at runtime (a projection bug must not kill the daemon); the tests parse the
 *   result with `RunView` instead.
 */
import type { AnyStateMachine, SnapshotFrom, StateValue } from 'xstate';
import type { PlanPhase } from '../contracts/domain.js';
import type { FindingView, PhaseView, RunView, Stage } from '../contracts/view.js';
import { blocks, type PhaseContext } from '../machines/phase.js';
import { phaseChildId, runMachine, type PhaseStatus } from '../machines/run.js';

/** A run's snapshot: the machine's own context and children, as `RunHost` hands it over. */
export type RunSnapshot = SnapshotFrom<typeof runMachine>;

/** The leaf state id, so `active.shipping.ready` and `paused` both answer one word. */
function leafState(value: StateValue): string {
  if (typeof value === 'string') return value;
  const child = Object.values(value)[0];
  return child === undefined ? '' : leafState(child);
}

function stageOf(snapshot: RunSnapshot, leaf: string): Stage {
  if (leaf === 'done' || leaf === 'failed' || leaf === 'cancelled') return leaf;
  return snapshot.context.stage as Stage;
}

function buildingWords(phases: Array<{ status: PhaseStatus }>): string {
  if (phases.length === 0) return 'Building';
  const done = phases.filter((phase) => phase.status === 'done').length;
  return `Building ${done} of ${phases.length} phases`;
}

function stageWords(context: RunSnapshot['context'], stage: Stage, leaf: string): string {
  switch (stage) {
    case 'intake':
      return 'Getting the goal straight';
    case 'specDrafting':
      return 'Writing the spec';
    case 'specReview':
      return 'Spec ready for you';
    case 'planning':
      return 'Writing the plan';
    case 'planReview':
      return 'Plan ready for you';
    case 'building':
      return buildingWords(
        context.plan === null
          ? []
          : context.plan.phases.map((phase) => ({ status: context.phases[phase.id] ?? 'waiting' })),
      );
    case 'finalReview':
      return 'Reviewing the whole run';
    case 'shipping':
      return leaf === 'opening' ? 'Opening the pull request' : 'Waiting for you to open the pull request';
    case 'done':
      return 'Pull request opened';
    case 'failed':
      return 'Stopped with a problem';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** A phase's state in words (§9.1 rule 4). The state id itself stays in `state`, for code. */
function phaseWords(leaf: string, deps: string[], taskCount: number): string {
  switch (leaf) {
    case 'waiting':
      return deps.length > 0 ? `waiting for ${deps.join(', ')}` : 'waiting to start';
    case 'building':
      return `building ${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`;
    case 'merging':
      return 'merging the tasks';
    case 'resolving':
      return 'resolving a conflict';
    case 'reviewing':
      return 'in review';
    case 'queuedForVerify':
      return 'waiting for a verification slot';
    case 'verifying':
      return 'verifying';
    case 'proving':
      return 'collecting proof';
    case 'deciding':
      return 'waiting for the PM';
    case 'awaitingYou':
      return 'waiting on you';
    case 'fixing':
      return 'fixing';
    case 'continuing':
      return 'carrying on';
    case 'passed':
      return 'merging into the run';
    case 'done':
      return 'done';
    case 'stopped':
    case 'cancelled':
      return 'stopped';
    default:
      return 'waiting to start';
  }
}

/** §8: a finding's status says what bdc did about it, not just what it is. */
function findingViews(context: PhaseContext, leaf: string): FindingView[] {
  const settled = leaf === 'passed' || leaf === 'done';
  const views: FindingView[] = [];
  for (const [lens, findings] of Object.entries(context.findings)) {
    const blockOn = context.lenses[lens]?.block_on ?? 'high';
    for (const finding of findings) {
      const override = context.overrides.find((candidate) => candidate.lens === undefined || candidate.lens === lens);
      const status: FindingView['status'] = override
        ? 'overridden'
        : !blocks(finding.severity, blockOn)
          ? 'advisory'
          : leaf === 'fixing'
            ? 'fixing'
            : settled
              ? 'fixed'
              : 'open';
      views.push({ ...finding, lens, status, note: override?.reason ?? '' });
    }
  }
  return views;
}

/** §8: a run-level finding's status says what the run did about it (§4.5: continue or stop). */
function finalFindingViews(context: RunSnapshot['context']): FindingView[] {
  const views: FindingView[] = [];
  for (const [lens, findings] of Object.entries(context.reviewFindings)) {
    const blockOn = context.config.lenses[lens]?.block_on ?? 'high';
    // The PM's decision on the whole run is recorded against the run, not against a phase (§4.5).
    const override = context.overrides.find(
      (candidate) => candidate.phaseId === 'run' && (candidate.lens === undefined || candidate.lens === lens),
    );
    for (const finding of findings) {
      const status: FindingView['status'] = override
        ? override.who === 'person'
          ? 'overridden'
          : 'continued'
        : blocks(finding.severity, blockOn)
          ? 'open'
          : 'advisory';
      views.push({ ...finding, lens, status, note: override?.reason ?? '' });
    }
  }
  return views;
}

/** A phase that has no child actor: the run knows how it ended, not what it did. */
function settledPhaseView(phase: PlanPhase, status: string): PhaseView {
  const state = status === 'done' ? 'done' : status === 'stopped' ? 'stopped' : 'waiting';
  return {
    id: phase.id,
    title: phase.title,
    deps: phase.deps,
    state,
    words: phaseWords(state, phase.deps, 0),
    needsYou: false,
    attemptsUsed: 0,
    findings: [],
    verification: null,
    proof: [],
  };
}

function phaseView(phase: PlanPhase, snapshot: RunSnapshot): PhaseView {
  const status = snapshot.context.phases[phase.id] ?? 'waiting';
  const child = snapshot.children[phaseChildId(phase.id)] as { getSnapshot(): SnapshotFrom<AnyStateMachine> } | undefined;
  if (child === undefined) return settledPhaseView(phase, status);
  const childSnapshot = child.getSnapshot();
  const context = childSnapshot.context as PhaseContext;
  const leaf = leafState(childSnapshot.value);
  return {
    id: phase.id,
    title: phase.title,
    deps: phase.deps,
    state: leaf,
    words: phaseWords(leaf, phase.deps, context.tasks.length),
    needsYou: leaf === 'awaitingYou',
    attemptsUsed: context.attemptsUsed,
    findings: findingViews(context, leaf),
    verification:
      context.verificationResult === null
        ? null
        : {
            passed: context.verificationResult.passed,
            steps: context.verificationResult.steps.map((step) => ({
              name: step.name,
              command: step.command,
              exitCode: step.exitCode,
              durationMs: step.durationMs,
              outputTail: step.outputTail,
            })),
          },
    proof: context.proofItems,
  };
}

/** One run snapshot, as the panels and `bdc status` see it (§7.2). */
export function projectRun(snapshot: RunSnapshot): RunView {
  const context = snapshot.context;
  const leaf = leafState(snapshot.value);
  const stage = stageOf(snapshot, leaf);
  const paused = leaf === 'paused';
  const phases = context.plan === null ? [] : context.plan.phases.map((phase) => phaseView(phase, snapshot));
  const proposals = context.chat.flatMap((entry) =>
    entry.proposalId === undefined ? [] : [{ id: entry.proposalId, text: entry.text }],
  );
  const words = stageWords(context, stage, leaf);
  return {
    runId: context.runId,
    goal: context.goal,
    stage,
    stageWords: paused ? `Paused — ${words}` : words,
    paused,
    // Anything that waits on the person: a review to approve, a question, an agent's prompt (§7.2).
    needsYou:
      stage === 'specReview' ||
      stage === 'planReview' ||
      (stage === 'shipping' && leaf === 'ready') ||
      context.asking !== null ||
      context.agentPrompts.length > 0,
    error: context.error === null ? null : context.error.detail,
    asking:
      context.asking === null
        ? null
        : { askId: context.asking.askId, scope: context.asking.scope, questions: context.asking.questions },
    agentPrompts: context.agentPrompts,
    chat: context.chat.map((entry) => ({ from: entry.from === 'person' ? ('you' as const) : ('pm' as const), text: entry.text })),
    proposals,
    brief: context.brief,
    spec:
      context.spec === null
        ? null
        : { version: context.specVersion, markdown: context.spec, comments: context.specComments },
    plan: context.plan,
    phases,
    finalFindings: finalFindingViews(context),
    pullRequest: context.pr,
  };
}
