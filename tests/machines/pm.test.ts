import { createActor, enqueueActions, setup, type AnyActorRef } from 'xstate';
import { describe, expect, it } from 'vitest';
import type { AgentJob } from '../../src/contracts/actors.js';
import type { Question } from '../../src/contracts/domain.js';
import type { AgentOutcome, AgentToParent, ParentToAgent, PersonEvent, PmToRun, RunToPm } from '../../src/contracts/events.js';
import {
  ASK_USER_AVAILABLE,
  answeredNote,
  answersPrompt,
  decidePrompt,
  intakePrompt,
  messagePrompt,
  pmMachine,
  primePrompt,
  submissionToRun,
  type PmInput,
  type PmRequest,
  type TranscriptEntry,
} from '../../src/machines/pm.js';

const GOAL = 'Add a health check endpoint';
const PM_INPUT: PmInput = { runId: 'r1', root: '/repo', agent: { cli: 'pi', model: '' }, goal: GOAL };

/** One thing the PM agent does on command: a result, a question to the person, or the answer coming back. */
type Step =
  | { kind: 'result'; outcome: AgentOutcome }
  | { kind: 'asking'; askId: string; questions: Question[] }
  | { kind: 'askDone'; askId: string };

interface Script {
  jobs: AgentJob[];
  prompts: string[];
  /** The job keys whose agent was told to close its terminal. */
  closed: string[];
  /** The keys the agent was sent for a prompt choice. */
  choices: string[];
  steps: Step[];
}

const crashed: Step = { kind: 'result', outcome: { status: 'crashed', detail: 'terminal exited' } };
const brief = { brief: 'A health check endpoint at /health', decisions: [], assumptions: [] };

/** The agent machine's stub: it records its job and acts when the test tells it to (§5.5 is another slice). */
function agentStub(script: Script) {
  return setup({
    types: { context: {} as AgentJob, input: {} as AgentJob, events: {} as ParentToAgent | { type: 'TEST_STEP' } },
    actions: {
      recordJob: ({ context }) => {
        script.jobs.push(context);
      },
      recordPrompt: ({ event }) => {
        if (event.type === 'FOLLOW_UP') script.prompts.push(event.prompt);
      },
      recordClose: ({ context }) => {
        script.closed.push(context.key);
      },
      recordChoice: ({ context, event }) => {
        if (event.type === 'PROMPT_CHOICE') script.choices.push(`${context.key}:${event.choice}`);
      },
      step: enqueueActions(({ context, enqueue }) => {
        const next = script.steps.shift();
        if (next === undefined) return;
        if (next.kind === 'result') {
          enqueue.sendParent({ type: 'AGENT_RESULT', key: context.key, outcome: next.outcome });
        } else if (next.kind === 'asking') {
          enqueue.sendParent({ type: 'AGENT_ASKING', key: context.key, askId: next.askId, questions: next.questions });
        } else {
          enqueue.sendParent({ type: 'AGENT_ASK_DONE', key: context.key, askId: next.askId });
        }
      }),
    },
  }).createMachine({
    context: ({ input }) => input,
    entry: 'recordJob',
    initial: 'running',
    states: {
      running: {
        on: {
          FOLLOW_UP: { actions: 'recordPrompt' },
          CLOSE: { actions: 'recordClose' },
          PROMPT_CHOICE: { actions: 'recordChoice' },
          TEST_STEP: { actions: 'step' },
        },
      },
    },
  });
}

function childOf(actor: AnyActorRef, id?: string): AnyActorRef {
  const children = actor.getSnapshot().children;
  const found = id === undefined ? Object.values(children).find((child) => child !== undefined) : children[id];
  if (found === undefined) throw new Error(`no child ${id ?? '(first)'}`);
  return found;
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at index ${index}`);
  return item;
}

/**
 * The PM's parent, which is the run: a recorder of `PmToRun` events. The PM sends to its parent, so
 * it needs one.
 */
function harness(steps: Step[] = []) {
  const script: Script = { jobs: [], prompts: [], closed: [], choices: [], steps: [...steps] };
  const received: PmToRun[] = [];
  const parent = setup({
    types: { context: {} as { goal: string }, events: {} as PmToRun, input: {} as PmInput },
    actors: { pm: pmMachine.provide({ actors: { agent: agentStub(script) } }) },
    actions: {
      record: ({ event }) => {
        received.push(event);
      },
    },
  }).createMachine({
    context: ({ input }) => ({ goal: input.goal }),
    entry: enqueueActions(({ context, enqueue }) => {
      enqueue.spawnChild('pm', { id: 'pm', input: PM_INPUT });
      enqueue.sendTo('pm', { type: 'INTAKE', goal: context.goal });
    }),
    on: { '*': { actions: 'record' } },
  });
  let actor = createActor(parent, { input: PM_INPUT }).start();
  const pm = () => childOf(actor, 'pm');
  return {
    script,
    received,
    pm,
    agent: () => childOf(pm()),
    send: (event: RunToPm | AgentToParent | Extract<PersonEvent, { type: 'PROMPT_CHOICE' }>) => pm().send(event),
    step: () => childOf(pm()).send({ type: 'TEST_STEP' }),
    state: () => pm().getSnapshot().value,
    /** Persist → JSON → restore, the way the daemon does it (§5.7). */
    restore: () => {
      const persisted = JSON.parse(JSON.stringify(actor.getPersistedSnapshot()));
      actor = createActor(parent, { snapshot: persisted, input: PM_INPUT }).start();
    },
  };
}

describe('pmMachine: prompts are pure and name the submit tool', () => {
  it('each kind names the tool the PM has to call', () => {
    // §3.4: the question tool is attached, and the intake prompt teaches the grill-me method in full.
    expect(ASK_USER_AVAILABLE).toBe(true);
    expect(intakePrompt(GOAL)).toContain('ask_user');
    expect(intakePrompt(GOAL)).toContain('submit_brief');
    expect(intakePrompt(GOAL)).toContain('recommended');
    expect(intakePrompt(GOAL)).toMatch(/design tree/);
    expect(intakePrompt(GOAL)).toMatch(/round/i);
    expect(intakePrompt(GOAL)).toMatch(/never ask the\s+person something you can look up/i);
    expect(intakePrompt(GOAL)).toMatch(/`confirm` question/);
    expect(intakePrompt(GOAL)).toMatch(/returns at once/);
    // The prompt for a CLI without the tool still says to write the brief and list assumptions.
    expect(intakePrompt(GOAL, false)).not.toContain('ask_user');
    expect(intakePrompt(GOAL, false)).toContain('assumptions');
    expect(messagePrompt('why is p2 waiting?')).toContain('`reply`');
    expect(messagePrompt('why is p2 waiting?')).not.toContain('`propose`');
    const decide = decidePrompt({
      scope: 'p2',
      blocker: { kind: 'verify', summary: 'unit tests fail', evidence: ['1 failing'] },
      fixAllowed: true,
    });
    expect(decide).toContain('`decide`');
    expect(decide).toContain('p2');
    expect(decide).toContain('unit tests fail');
    expect(decide).toContain('Attempts are left');
    expect(
      decidePrompt({ scope: 'p2', blocker: { kind: 'verify', summary: 'x', evidence: [] }, fixAllowed: false }),
    ).toContain('No attempts are left');
    expect(answeredNote('ask-1', [{ questionId: 'q1', picked: ['yes'], text: '', skipped: false }])).toContain('ask-1');
  });

  it('a restarted session is primed with the whole transcript', () => {
    const transcript: TranscriptEntry[] = [
      { from: 'run', text: 'The person says: hello' },
      { from: 'pm', text: 'Submission: hi' },
    ];
    const primed = primePrompt({ runId: 'r1', goal: GOAL, transcript });
    expect(primed).toContain(GOAL);
    expect(primed).toContain('hello');
    expect(primed).toContain('Submission: hi');
  });

  it('a submission maps to the event the run gets, per request kind', () => {
    const intake: PmRequest = { id: 'r', type: 'INTAKE', goal: GOAL };
    expect(submissionToRun(intake, brief)).toEqual({ type: 'PM_BRIEF', brief });
    expect(submissionToRun(intake, { nonsense: true })).toBeNull();

    const message: PmRequest = { id: 'r', type: 'MESSAGE', text: 'hi' };
    expect(submissionToRun(message, { text: 'hello' })).toEqual({ type: 'PM_REPLY', text: 'hello' });
    expect(
      submissionToRun(message, { proposalId: 'p1', text: 'keep p5 up', event: { type: 'OPEN_PR', draft: true } }),
    ).toEqual({ type: 'PM_PROPOSAL', proposalId: 'p1', text: 'keep p5 up', event: { type: 'OPEN_PR', draft: true } });

    const decide: PmRequest = {
      id: 'r',
      type: 'DECIDE',
      scope: 'p2',
      blocker: { kind: 'review', summary: 'x', evidence: [] },
      fixAllowed: true,
    };
    expect(submissionToRun(decide, { action: 'continue', reason: 'low risk' })).toEqual({
      type: 'PM_DECISION',
      scope: 'p2',
      decision: { action: 'continue', reason: 'low risk' },
    });
    expect(submissionToRun(decide, { action: 'fix', reason: 'no instructions' })).toBeNull();
  });
});

describe('pmMachine', () => {
  it('starts one long-lived PM session with the goal, and takes the intake request', () => {
    const test = harness();
    expect(test.script.jobs).toHaveLength(1);
    const job = nth(test.script.jobs, 0);
    expect(job.key).toBe('r1/pm');
    expect(job.role).toBe('pm');
    expect(job.keepAlive).toBe(true);
    expect(job.submit).toBe('brief');
    expect(job.prompt).toContain(GOAL);
    expect(test.state()).toBe('thinking');
    expect(nth(test.script.prompts, 0)).toContain('submit_brief');
  });

  it('the brief goes to the run and the PM goes back to idle', () => {
    const test = harness([{ kind: 'result', outcome: { status: 'done', submission: brief } }]);
    test.step();
    expect(test.received).toEqual([{ type: 'PM_BRIEF', brief }]);
    expect(test.state()).toBe('idle');
  });

  it('a message becomes a reply turn, and a proposal becomes PM_PROPOSAL', () => {
    const test = harness([
      { kind: 'result', outcome: { status: 'done', submission: brief } },
      { kind: 'result', outcome: { status: 'done', submission: { text: 'p2 is waiting on p1' } } },
      {
        kind: 'result',
        outcome: { status: 'done', submission: { proposalId: 'p1', text: 'keep p5 up', event: { type: 'OPEN_PR', draft: true } } },
      },
    ]);
    test.step();
    test.send({ type: 'MESSAGE', text: 'why is p2 waiting?' });
    expect(test.script.prompts).toHaveLength(2);
    expect(nth(test.script.prompts, 1)).toContain('why is p2 waiting?');
    test.step();
    test.send({ type: 'MESSAGE', text: 'keep p5 up' });
    test.step();
    expect(test.received.slice(1)).toEqual([
      { type: 'PM_REPLY', text: 'p2 is waiting on p1' },
      { type: 'PM_PROPOSAL', proposalId: 'p1', text: 'keep p5 up', event: { type: 'OPEN_PR', draft: true } },
    ]);
  });

  it('a decision request carries its scope and gets a decision back', () => {
    const test = harness([
      { kind: 'result', outcome: { status: 'done', submission: brief } },
      { kind: 'result', outcome: { status: 'done', submission: { action: 'fix', reason: 'mechanical', instructions: 'rename the flag' } } },
    ]);
    test.step();
    test.send({
      type: 'DECIDE',
      scope: 'p2',
      blocker: { kind: 'verify', summary: 'unit tests fail', evidence: [] },
      fixAllowed: true,
    });
    expect(nth(test.script.prompts, 1)).toContain('p2');
    expect(nth(test.script.prompts, 1)).toContain('`decide`');
    test.step();
    expect(test.received[1]).toEqual({
      type: 'PM_DECISION',
      scope: 'p2',
      decision: { action: 'fix', reason: 'mechanical', instructions: 'rename the flag' },
    });
  });

  it('runs one request at a time: a second request waits for the first turn', () => {
    const test = harness([
      { kind: 'result', outcome: { status: 'done', submission: brief } },
      { kind: 'result', outcome: { status: 'done', submission: { text: 'later' } } },
    ]);
    test.send({ type: 'MESSAGE', text: 'are we there yet?' });
    test.send({ type: 'MESSAGE', text: 'and now?' });
    expect(test.script.prompts).toHaveLength(1);
    expect(test.state()).toBe('thinking');
    test.step();
    expect(test.script.prompts).toHaveLength(2);
    expect(nth(test.script.prompts, 1)).toContain('are we there yet?');
    test.step();
    expect(test.script.prompts).toHaveLength(3);
    expect(nth(test.script.prompts, 2)).toContain('and now?');
  });

  it('the PM asking the person reaches the run, and the answer does not become a turn', () => {
    const test = harness([
      { kind: 'result', outcome: { status: 'done', submission: brief } },
      {
        kind: 'asking',
        askId: 'ask-1',
        questions: [{ id: 'q1', title: 'Which provider?', body: '', kind: 'single', options: [], allowOther: true }],
      },
      { kind: 'askDone', askId: 'ask-1' },
    ]);
    test.step();
    test.send({
      type: 'DECIDE',
      scope: 'p2',
      blocker: { kind: 'review', summary: 'product decision', evidence: [] },
      fixAllowed: true,
    });
    test.step();
    expect(test.received[1]).toMatchObject({ type: 'PM_ASKING', scope: 'p2', askId: 'ask-1' });
    const promptsBefore = test.script.prompts.length;
    test.step();
    expect(test.received[2]).toEqual({ type: 'PM_ASK_DONE', askId: 'ask-1' });
    // The answer is recorded, not prompted: the MCP `ask_user` call carries it (§3.4).
    test.send({ type: 'ANSWER', askId: 'ask-1', answers: [{ questionId: 'q1', picked: ['google'], text: '', skipped: false }] });
    expect(test.script.prompts).toHaveLength(promptsBefore);
    expect(test.received[3]).toEqual({ type: 'PM_ASK_DONE', askId: 'ask-1' });
    expect(test.state()).toBe('thinking');
  });

  it("the person's answer reaches the PM session as the follow-up of the turn that asked", () => {
    const questions: Question[] = [
      {
        id: 'q1',
        title: 'Which sign-in provider?',
        body: '',
        kind: 'single',
        options: [
          { id: 'google', label: 'Google Workspace' },
          { id: 'okta', label: 'Okta' },
        ],
        recommended: 'google',
        allowOther: true,
      },
      { id: 'q2', title: 'Which domains?', body: '', kind: 'text', options: [], allowOther: true },
      { id: 'q3', title: 'Keep the old login?', body: '', kind: 'confirm', options: [], allowOther: false },
    ];
    const answers = [
      { questionId: 'q1', picked: ['google'], text: '', skipped: false },
      { questionId: 'q2', picked: [], text: 'acme.com only', skipped: false },
      { questionId: 'q3', picked: [], text: '', skipped: true },
    ];
    const test = harness([{ kind: 'asking', askId: 'ask-1', questions }]);
    test.step();
    expect(test.received[0]).toMatchObject({ type: 'PM_ASKING', askId: 'ask-1', questions });

    test.send({ type: 'ANSWER', askId: 'ask-1', answers });

    // The answer is not a turn of its own: it is pasted into the session as the turn's next message,
    // with the labels the person picked rather than the option ids (§3.4, §9.4).
    expect(test.script.prompts).toHaveLength(2);
    const followUp = nth(test.script.prompts, 1);
    expect(followUp).toBe(answersPrompt(questions, answers));
    expect(followUp).toContain('The person answered:');
    expect(followUp).toContain('- Which sign-in provider? → Google Workspace');
    expect(followUp).toContain('- Which domains? → acme.com only');
    expect(followUp).toContain('- Keep the old login? → skipped (decide yourself and say so in assumptions)');
    expect(followUp).not.toContain('google');
    expect(test.received.at(-1)).toEqual({ type: 'PM_ASK_DONE', askId: 'ask-1' });

    // The transcript keeps both sides of the round: the questions and the answers (§5.4).
    const transcript = (test.pm().getSnapshot().context as { transcript: TranscriptEntry[] }).transcript;
    const texts = transcript.map((entry) => entry.text);
    expect(texts).toContain('Asked the person: Which sign-in provider? | Which domains? | Keep the old login?');
    expect(texts).toContain(followUp);
    // The request is still the current one: the turn goes on until the PM submits.
    expect((test.pm().getSnapshot().context as { current: unknown }).current).not.toBeNull();
  });

  it('an answer to an ask this turn is not waiting on is recorded, not pasted', () => {
    const test = harness([
      {
        kind: 'asking',
        askId: 'ask-1',
        questions: [{ id: 'q1', title: 'Which?', body: '', kind: 'text', options: [], allowOther: true }],
      },
    ]);
    test.step();

    test.send({ type: 'ANSWER', askId: 'ask-9', answers: [{ questionId: 'q1', picked: [], text: 'later', skipped: false }] });

    expect(test.script.prompts).toHaveLength(1);
    expect(test.received.at(-1)).toEqual({ type: 'PM_ASK_DONE', askId: 'ask-9' });
    const transcript = (test.pm().getSnapshot().context as { transcript: TranscriptEntry[] }).transcript;
    expect(transcript.at(-1)?.text).toBe(answeredNote('ask-9', [{ questionId: 'q1', picked: [], text: 'later', skipped: false }]));
  });

  it('a lost session restarts once, primed with the transcript, and retries the request', () => {
    const test = harness([crashed, { kind: 'result', outcome: { status: 'done', submission: brief } }]);
    expect(test.script.prompts).toHaveLength(1);
    test.step();
    expect(test.script.jobs).toHaveLength(2);
    const restarted = nth(test.script.jobs, 1);
    expect(restarted.key).toBe('r1/pm/1');
    expect(restarted.prompt).toContain('previous session was lost');
    expect(restarted.prompt).toContain(GOAL);
    // The request is retried in the new session, once.
    expect(test.script.prompts).toHaveLength(2);
    expect(test.state()).toBe('thinking');
    test.step();
    expect(test.received).toEqual([{ type: 'PM_BRIEF', brief }]);
  });

  it('a second failure reports PM_FAILED and drops the request', () => {
    const test = harness([crashed, crashed, { kind: 'result', outcome: { status: 'done', submission: { text: 'still here' } } }]);
    test.step();
    test.step();
    expect(test.received).toHaveLength(1);
    expect(test.received[0]).toMatchObject({ type: 'PM_FAILED' });
    expect(test.state()).toBe('idle');
    // The PM session is still usable: the next message gets its own turn.
    test.send({ type: 'MESSAGE', text: 'hello?' });
    expect(test.script.prompts).toHaveLength(3);
    test.step();
    expect(test.received[1]).toEqual({ type: 'PM_REPLY', text: 'still here' });
  });

  it('survives a persist → restore while thinking without launching a second session', () => {
    const test = harness([{ kind: 'result', outcome: { status: 'done', submission: brief } }]);
    expect(test.state()).toBe('thinking');
    expect(test.script.prompts).toHaveLength(1);
    test.restore();
    expect(test.state()).toBe('thinking');
    expect(test.script.jobs).toHaveLength(1);
    // The request is put into the session again: the turn is an invoked actor, so a restore
    // re-establishes it (an entry action would not run again, §5.7).
    expect(test.script.prompts).toHaveLength(2);
    expect(nth(test.script.prompts, 1)).toBe(nth(test.script.prompts, 0));
    test.step();
    expect(test.received).toEqual([{ type: 'PM_BRIEF', brief }]);
    expect(test.state()).toBe('idle');
    expect(test.script.jobs).toHaveLength(1);
  });

  it('closes its agent when the run closes it', () => {
    const test = harness([{ kind: 'result', outcome: { status: 'done', submission: brief } }]);
    test.step();

    // The run ended: the PM session's terminal closes with it (§5.5).
    test.send({ type: 'CLOSE' });
    expect(test.script.closed).toEqual(['r1/pm']);
    expect(test.state()).toBe('idle');
  });

  it("surfaces its own session's trust prompt and sends the person's choice to the agent", () => {
    const test = harness([{ kind: 'result', outcome: { status: 'done', submission: brief } }]);
    test.step();
    const trust = { prompt: 'Trust this folder?', choices: ['Trust', "Don't"] };

    // The prompt is the person's to answer, so the run shows it as a card (§3.3).
    test.send({ type: 'AGENT_NEEDS_YOU', key: 'r1/pm', ...trust });
    expect(test.received).toContainEqual({ type: 'AGENT_NEEDS_YOU', key: 'r1/pm', ...trust });

    // A choice for another agent is not this session's business.
    test.send({ type: 'PROMPT_CHOICE', agentKey: 'r1/p1/builder', choice: 'Trust' });
    expect(test.script.choices).toEqual([]);

    test.send({ type: 'PROMPT_CHOICE', agentKey: 'r1/pm', choice: 'Trust' });
    expect(test.script.choices).toEqual(['r1/pm:Trust']);
  });
});

/** Found in the first real grill-me run (17 Nov 2026): ticking nothing reached the PM as "skipped". */
describe('answersPrompt', () => {
  it('says "none" for a multi question answered with nothing ticked, and "skipped" only when skipped', () => {
    const question = { id: 'extras', title: 'Which extras?', body: '', kind: 'multi' as const, options: [{ id: 'help', label: '--help' }], allowOther: true };
    expect(answersPrompt([question], [{ questionId: 'extras', picked: [], text: '', skipped: false }])).toContain('Which extras? → none of these');
    expect(answersPrompt([question], [{ questionId: 'extras', picked: [], text: '', skipped: true }])).toContain('skipped');
  });
});
