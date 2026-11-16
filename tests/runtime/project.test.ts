import { createActor, fromPromise } from 'xstate';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckProofInput, CheckProofOutput, RunVerificationInput, RunVerificationOutput } from '../../src/contracts/actors.js';
import { ProjectConfig } from '../../src/contracts/domain.js';
import { RunView, type RunView as RunViewType } from '../../src/contracts/view.js';
import { scriptedActors } from '../../src/effects/scripted.js';
import type { RunInput } from '../../src/machines/run.js';
import { projectRun, type RunSnapshot } from '../../src/runtime/project.js';
import { wiredRunMachine } from '../../src/runtime/wire.js';

const AGENT = { cli: 'pi', model: '' };
const CONFIG = ProjectConfig.parse({
  agents: { pm: AGENT, specWriter: AGENT, planner: AGENT, builder: AGENT, reviewer: AGENT, verifier: AGENT },
  lenses: { security: { block_on: 'high' } },
  verification: { parallel: 1, checks: [{ name: 'tests', run: 'echo ok' }] },
});

const INPUT: RunInput = { runId: 'r-projection', root: '/tmp/bdc-projection', goal: 'Add a health check', config: CONFIG, lensPrompts: {} };

type Actor = ReturnType<typeof createActor<ReturnType<typeof wiredRunMachine>>>;

/** The next snapshot the run reaches where `predicate` holds; the current one counts too. */
function nextWhere(actor: Actor, predicate: (snapshot: RunSnapshot) => boolean, what: string): Promise<RunSnapshot> {
  const current = actor.getSnapshot() as RunSnapshot;
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.unsubscribe();
      reject(new Error(`timed out waiting for ${what}`));
    }, 8_000);
    const subscription = actor.subscribe((snapshot) => {
      if (!predicate(snapshot as RunSnapshot)) return;
      clearTimeout(timer);
      subscription.unsubscribe();
      resolve(snapshot as RunSnapshot);
    });
  });
}

function stageIs(stage: string) {
  return (snapshot: RunSnapshot): boolean => projectRun(snapshot).stage === stage;
}

/** Every people-facing string in a view: they must not read like code (§9.1 rule 4). */
function words(view: RunViewType): string[] {
  return [view.stageWords, ...view.phases.map((phase) => phase.words)];
}

function expectPeopleWords(view: RunViewType): void {
  for (const text of words(view)) {
    expect(text).not.toMatch(/_/);
    expect(text).not.toMatch(/[a-z][A-Z]/);
    expect(text.trim()).not.toBe('');
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let actor: Actor | undefined;

afterEach(() => {
  actor?.stop();
  actor = undefined;
});

describe('projectRun', () => {
  it('projects the intake stage as a person would read it', { timeout: 10_000 }, () => {
    actor = createActor(wiredRunMachine(scriptedActors({ goal: INPUT.goal })), { input: INPUT });
    actor.start();

    const view = projectRun(actor.getSnapshot() as RunSnapshot);

    expect(RunView.safeParse(view).success).toBe(true);
    expect(view.runId).toBe('r-projection');
    expect(view.goal).toBe('Add a health check');
    expect(view.stage).toBe('intake');
    expect(view.stageWords).toBe('Getting the goal straight');
    expect(view.paused).toBe(false);
    expect(view.phases).toEqual([]);
    expect(view.pullRequest).toBeNull();
    expect(view.error).toBeNull();
    expectPeopleWords(view);
  });

  it('parses as a RunView in every stage of a run and says them in people words', { timeout: 10_000 }, async () => {
    actor = createActor(wiredRunMachine(scriptedActors({ goal: INPUT.goal })), { input: INPUT });
    actor.start();

    const specReview = await nextWhere(actor, stageIs('specReview'), 'spec review');
    const specView = projectRun(specReview);
    expect(RunView.safeParse(specView).success).toBe(true);
    expect(specView.stageWords).toBe('Spec ready for you');
    expect(specView.needsYou).toBe(true);
    expect(specView.brief).not.toBeNull();
    expect(specView.spec?.markdown).toContain('Add a health check');
    expectPeopleWords(specView);

    actor.send({ type: 'SPEC_APPROVED' });
    const planReview = await nextWhere(actor, stageIs('planReview'), 'plan review');
    const planView = projectRun(planReview);
    expect(RunView.safeParse(planView).success).toBe(true);
    expect(planView.stageWords).toBe('Plan ready for you');
    expect(planView.needsYou).toBe(true);
    expect(planView.plan?.phases.map((phase) => phase.id)).toEqual(['p1', 'p2']);
    expectPeopleWords(planView);

    actor.send({ type: 'PLAN_APPROVED' });
    const building = await nextWhere(actor, stageIs('building'), 'building');
    const buildingView = projectRun(building);
    expect(RunView.safeParse(buildingView).success).toBe(true);
    expect(buildingView.stageWords).toMatch(/^Building \d of \d phases$/);
    expect(buildingView.needsYou).toBe(false);
    expect(buildingView.phases).toHaveLength(2);
    expect(buildingView.phases.map((phase) => phase.id)).toEqual(['p1', 'p2']);
    // The phase machine's state id stays in `state`; `words` is for people.
    expect(buildingView.phases[0]?.state).not.toBe('');
    expectPeopleWords(buildingView);

    await nextWhere(actor, stageIs('shipping'), 'shipping');
    actor.send({ type: 'OPEN_PR', draft: true });
    const done = await nextWhere(actor, stageIs('done'), 'done');
    const doneView = projectRun(done);
    expect(RunView.safeParse(doneView).success).toBe(true);
    expect(doneView.stageWords).toBe('Pull request opened');
    expect(doneView.needsYou).toBe(false);
    expect(doneView.pullRequest?.path).toBe('.herd/pull-request.md');
    expectPeopleWords(doneView);
  });

  it('says a paused run is paused and keeps the stage it paused in', { timeout: 10_000 }, async () => {
    actor = createActor(wiredRunMachine(scriptedActors({ goal: INPUT.goal })), { input: INPUT });
    actor.start();

    const specReview = await nextWhere(actor, stageIs('specReview'), 'spec review');
    actor.send({ type: 'PAUSE' });
    const paused = await nextWhere(actor, (snapshot) => projectRun(snapshot).paused, 'pause');
    const view = projectRun(paused);

    expect(RunView.safeParse(view).success).toBe(true);
    expect(view.stage).toBe('specReview');
    expect(view.stageWords).toBe('Paused — Spec ready for you');
    expectPeopleWords(view);
    expect(specReview.context.stage).toBe('specReview');
  });

  it('reads a phase child snapshot: a phase that has not started waits for its dependency', { timeout: 10_000 }, async () => {
    actor = createActor(wiredRunMachine(scriptedActors({ goal: INPUT.goal })), { input: INPUT });
    actor.start();

    await nextWhere(actor, stageIs('specReview'), 'spec review');
    actor.send({ type: 'SPEC_APPROVED' });
    await nextWhere(actor, stageIs('planReview'), 'plan review');
    actor.send({ type: 'PLAN_APPROVED' });
    const building = await nextWhere(actor, stageIs('building'), 'building');

    const view = projectRun(building);
    const p2 = view.phases.find((phase) => phase.id === 'p2');
    expect(p2?.state).toBe('waiting');
    expect(p2?.words).toBe('waiting for p1');

    // The run's own snapshot does not change while a phase works, so read it again until the child
    // has moved on: this is what makes the view follow the run, not the stage.
    const deadline = Date.now() + 8_000;
    let p1 = projectRun(actor.getSnapshot() as RunSnapshot).phases.find((phase) => phase.id === 'p1');
    while (p1?.words !== 'building 1 task' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      p1 = projectRun(actor.getSnapshot() as RunSnapshot).phases.find((phase) => phase.id === 'p1');
    }
    expect(p1?.state).toBe('building');
    expect(p1?.words).toBe('building 1 task');
  });

  it('shows the questions of the ask that is waiting and counts them as waiting on the person', { timeout: 10_000 }, async () => {
    actor = createActor(wiredRunMachine(scriptedActors({ goal: INPUT.goal })), { input: INPUT });
    actor.start();

    const questions = [
      { id: 'q1', title: 'Which provider?', body: '', kind: 'single' as const, options: [], allowOther: true },
    ];
    actor.send({ type: 'PM_ASKING', scope: null, askId: 'ask-1', questions });
    const view = projectRun(actor.getSnapshot() as RunSnapshot);
    expect(RunView.safeParse(view).success).toBe(true);
    expect(view.asking).toEqual({ askId: 'ask-1', scope: null, questions });
    expect(view.needsYou).toBe(true);

    actor.send({ type: 'PM_ASK_DONE', askId: 'ask-1' });
    expect(projectRun(actor.getSnapshot() as RunSnapshot).asking).toBeNull();
  });

  it('shows an agent prompt as a card and stops waiting on the person when it is answered', { timeout: 10_000 }, async () => {
    actor = createActor(wiredRunMachine(scriptedActors({ goal: INPUT.goal })), { input: INPUT });
    actor.start();

    await nextWhere(actor, stageIs('specReview'), 'spec review');
    actor.send({ type: 'SPEC_APPROVED' });
    await nextWhere(actor, stageIs('planReview'), 'plan review');
    actor.send({ type: 'PLAN_APPROVED' });
    const building = await nextWhere(actor, stageIs('building'), 'building');
    expect(projectRun(building).needsYou).toBe(false);

    // The phase child forwards its builder's prompt (§3.3).
    const trust = { prompt: 'Trust this folder?', choices: ['Trust', "Don't"] };
    const key = `${INPUT.runId}/p1/t1/builder`;
    actor.send({ type: 'AGENT_NEEDS_YOU', key, ...trust });
    const asked = projectRun(actor.getSnapshot() as RunSnapshot);
    expect(RunView.safeParse(asked).success).toBe(true);
    expect(asked.agentPrompts).toEqual([{ agentKey: key, ...trust }]);
    expect(asked.needsYou).toBe(true);

    actor.send({ type: 'PROMPT_CHOICE', agentKey: key, choice: 'Trust' });
    const answered = projectRun(actor.getSnapshot() as RunSnapshot);
    expect(answered.agentPrompts).toEqual([]);
    expect(answered.needsYou).toBe(false);
  });

  it("keeps a phase's verification steps and projects them", { timeout: 10_000 }, async () => {
    const effects = scriptedActors({ goal: INPUT.goal });
    const step = { phase: 'check' as const, name: 'unit', command: 'npm test', exitCode: 0, durationMs: 3, outputTail: 'ok' };
    actor = createActor(
      wiredRunMachine({
        ...effects,
        runVerification: fromPromise<RunVerificationOutput, RunVerificationInput>(async () => ({
          passed: true,
          steps: [step],
          proofFiles: ['verify.log'],
        })),
        // Held, so the phase stays in `proving` with its verification on record long enough to read.
        checkProof: fromPromise<CheckProofOutput, CheckProofInput>(() => new Promise(() => undefined)),
      }),
      { input: INPUT },
    );
    actor.start();

    await nextWhere(actor, stageIs('specReview'), 'spec review');
    actor.send({ type: 'SPEC_APPROVED' });
    await nextWhere(actor, stageIs('planReview'), 'plan review');
    actor.send({ type: 'PLAN_APPROVED' });
    await nextWhere(actor, stageIs('building'), 'building');

    // A phase child's snapshot does not move the run's own subscription, so read it until it does.
    const deadline = Date.now() + 8_000;
    let verification = projectRun(actor.getSnapshot() as RunSnapshot).phases.find((phase) => phase.id === 'p1')?.verification;
    while (verification === null && Date.now() < deadline) {
      await sleep(5);
      verification = projectRun(actor.getSnapshot() as RunSnapshot).phases.find((phase) => phase.id === 'p1')?.verification;
    }
    expect(verification).toEqual({
      passed: true,
      steps: [{ name: 'unit', command: 'npm test', exitCode: 0, durationMs: 3, outputTail: 'ok' }],
    });
  });

  it('projects the whole-run findings: open, then continued with the PM reason', { timeout: 10_000 }, async () => {
    // A lens prompt with BLOCK makes the scripted reviewer report a high finding (§8).
    const input: RunInput = { ...INPUT, lensPrompts: { security: 'BLOCK: report a high finding' } };
    actor = createActor(wiredRunMachine(scriptedActors({ goal: INPUT.goal })), { input });
    actor.start();

    await nextWhere(actor, stageIs('specReview'), 'spec review');
    actor.send({ type: 'SPEC_APPROVED' });
    await nextWhere(actor, stageIs('planReview'), 'plan review');
    actor.send({ type: 'PLAN_APPROVED' });

    // A blocking finding of the whole-run review is open until the PM decides about it (§4.5).
    const open = await nextWhere(
      actor,
      (snapshot) => projectRun(snapshot).finalFindings.some((finding) => finding.status === 'open'),
      'an open run finding',
    );
    expect(projectRun(open).finalFindings).toEqual([
      {
        id: 'scripted-1',
        severity: 'high',
        summary: 'The scripted reviewer blocked this change',
        fix: 'Change the code',
        lens: 'security',
        status: 'open',
        note: '',
      },
    ]);

    // The scripted PM continues, and the reason is kept with the finding.
    const continued = await nextWhere(
      actor,
      (snapshot) => projectRun(snapshot).finalFindings.some((finding) => finding.status === 'continued'),
      'a continued run finding',
    );
    expect(projectRun(continued).finalFindings[0]).toMatchObject({ lens: 'security', status: 'continued', note: 'scripted' });

    await nextWhere(actor, stageIs('shipping'), 'shipping');
    actor.send({ type: 'OPEN_PR', draft: true });
    const done = await nextWhere(actor, stageIs('done'), 'done');
    const view = projectRun(done);
    expect(RunView.safeParse(view).success).toBe(true);
    expect(view.finalFindings.map((finding) => [finding.lens, finding.status, finding.note])).toEqual([
      ['security', 'continued', 'scripted'],
    ]);
  });

  it('projects a whole-run finding below the lens block level as advisory', { timeout: 10_000 }, async () => {
    const config = ProjectConfig.parse({
      ...CONFIG,
      // A high finding is below `critical`, so this lens does not block the run (§8).
      lenses: { security: { block_on: 'critical' } },
    });
    const input: RunInput = { ...INPUT, config, lensPrompts: { security: 'BLOCK: report a high finding' } };
    actor = createActor(wiredRunMachine(scriptedActors({ goal: INPUT.goal })), { input });
    actor.start();

    await nextWhere(actor, stageIs('specReview'), 'spec review');
    actor.send({ type: 'SPEC_APPROVED' });
    await nextWhere(actor, stageIs('planReview'), 'plan review');
    actor.send({ type: 'PLAN_APPROVED' });
    const advisory = await nextWhere(
      actor,
      (snapshot) => projectRun(snapshot).finalFindings.length > 0,
      'the whole-run finding',
    );
    expect(projectRun(advisory).finalFindings.map((finding) => [finding.lens, finding.status])).toEqual([
      ['security', 'advisory'],
    ]);
  });
});
