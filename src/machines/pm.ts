/**
 * pmMachine (spec §5.4): one long-lived PM session per run.
 *
 * The run sends requests (`RunToPm`) in; this machine keeps one PM agent session up and turns the
 * requests into turns of that session, one at a time, so the PM always decides with the latest
 * picture. Everything said both ways is kept in `transcript`, which is what a restarted session is
 * primed with — the person sees one continuous conversation either way (§5.4).
 *
 * Answers do not go through this machine as prompts. The PM asks through the MCP `ask_user` call
 * (§3.4); the daemon resolves that call with the person's answer, so the answer arrives back inside
 * the PM's own session. A `RunToPm` `ANSWER` is therefore never queued for a turn: wherever it
 * arrives it is recorded in the transcript and `PM_ASK_DONE` tells the run the ask is done. The
 * agent's own `AGENT_ASK_DONE` (its `ask_user` call returned) reports the same thing.
 *
 * A turn is put into the session by an invoked actor, not by an entry action, so a restore of
 * `thinking` re-establishes it: XState restarts invocations and does not re-run entry actions
 * (§5.7). A `FOLLOW_UP` that arrives before the session's terminal is up is queued by the agent
 * machine, so the turn cannot be lost in the gap either.
 *
 * `CLOSE` from the run (the run ended, §5.5) goes on to the agent, which closes its terminal. A
 * trust or permission prompt of the session's terminal is forwarded to the run as `AGENT_NEEDS_YOU`
 * and the person's `PROMPT_CHOICE` comes back the same way (§3.3): `PmToRun`/`RunToPm` have no
 * shapes for those two yet, so the PM reuses the person event and the agent event.
 */
import {
  assign,
  enqueueActions,
  fromCallback,
  setup,
  type AnyActorLogic,
  type EventObject,
} from 'xstate';
import { z } from 'zod';
import { Brief, Decision, type AgentChoice, type Answer, type Blocker, type Question } from '../contracts/domain.js';
import { PersonEvent, type AgentOutcome, type AgentToParent, type PmToRun, type RunToPm } from '../contracts/events.js';
import type { AgentJob } from '../contracts/actors.js';

export interface PmInput {
  runId: string;
  root: string;
  /** The PM's CLI and model, chosen by the person (§3.1). */
  agent: AgentChoice;
  goal: string;
}

/** The PM's role timeout: 15 min, like every role that is not a builder (§3.3). */
const PM_TIMEOUT_MS = 15 * 60 * 1000;

/** A request that becomes a PM turn. `ANSWER` is not one: it is recorded where it arrives (above). */
export type PmRequest = Extract<RunToPm, { type: 'INTAKE' | 'MESSAGE' | 'DECIDE' }> & { id: string };

/** The person's answer to an agent prompt (§3.3). `RunToPm` has no shape for it yet, so it is the
 * person event itself: the run hands it to the PM, which checks the key against its own session. */
type PmPromptChoice = Extract<PersonEvent, { type: 'PROMPT_CHOICE' }>;

/**
 * The turn invocation telling this machine to paste the current request into the PM session. It is
 * an internal event of this machine, not something the run sends.
 */
type PmMachineEvent =
  | RunToPm
  | AgentToParent
  | PmPromptChoice
  | { type: 'DELIVER_REQUEST'; agentId: string; prompt: string };

/** One thing said in the PM conversation; a restarted session is primed with all of them. */
export interface TranscriptEntry {
  from: 'run' | 'pm';
  text: string;
}

interface PmContext {
  runId: string;
  root: string;
  agent: AgentChoice;
  goal: string;
  /** The live PM agent: a restart gets a new key suffix so the daemon launches a new session. */
  agentKey: string;
  agentId: string;
  transcript: TranscriptEntry[];
  queue: PmRequest[];
  current: PmRequest | null;
  /** Turns the current request has had; 2 means it already used its one retry after a restart. */
  turns: number;
  restarts: number;
  requests: number;
  asking: { askId: string; scope: string | null } | null;
  failure: string | null;
}

/** A child machine the daemon wires (§5.1). Typed as any actor logic so `provide` can supply it. */
const notProvided = (name: string): AnyActorLogic =>
  // SAFETY: the slot must accept the real agent machine or a test stub, whose context and events
  // differ from this placeholder's; nothing reads the placeholder's snapshot, it only throws.
  fromCallback<EventObject, unknown>(() => {
    throw new Error(`${name} not provided`);
  }) as unknown as AnyActorLogic;

// ── Prompts (§4.1, §6): pure, so the shape of every turn is testable ────────────────────

/** The intake turn: grill the person through `ask_user`, then `submit_brief` (§4.1). */
export function intakePrompt(goal: string): string {
  return [
    `The person's goal: ${goal}`,
    '',
    'Run the grill-me intake: map the goal as a design tree, look up what you can in the repo yourself,',
    'and ask in rounds. Every round is one `ask_user` call with the questions you can ask now without',
    'guessing at answers you have not heard, each with your recommended answer.',
    'Never ask the person for something you can find in the repo. When nothing is left silently assumed,',
    'ask one last `confirm` question about the shared understanding, then call `submit_brief` with',
    '{ brief, decisions[], assumptions[] }.',
  ].join('\n');
}

/** A chat turn: `reply`, or `propose` when the person asked for something bdc can do (§4.7). */
export function messagePrompt(text: string): string {
  return [
    `The person says: ${text}`,
    '',
    'Answer in one or two sentences and call `reply` with { text }.',
    'If the message asks for an action bdc can take, call `propose` with',
    '{ proposalId, text, event } instead: `text` says what applying it does and `event` is the bdc event',
    'that does it. The person applies or discards it; you do not apply it yourself.',
  ].join('\n');
}

/** A decision turn (§6): one `decide` call, after `ask_user` if the answer is not yours to make. */
export function decidePrompt(request: { scope: string; blocker: Blocker; fixAllowed: boolean }): string {
  const evidence = request.blocker.evidence.length ? ` Evidence: ${request.blocker.evidence.join(' | ')}` : '';
  return [
    `Blocked: ${request.scope} — ${request.blocker.kind}: ${request.blocker.summary}.${evidence}`,
    '',
    'Call `decide` with { action, reason, instructions?, builder? }.',
    `- fix: the builder changes the code. ${request.fixAllowed ? 'Attempts are left.' : 'No attempts are left, so fix is not available.'}`,
    '- continue: go on and record the override with the reason that justifies it.',
    '- stop: stop the work.',
    'Decide yourself when the fix is mechanical and inside the spec. When it is a product decision, a risk',
    'you would accept on the person\'s behalf, or a change to the spec, call `ask_user` first and decide',
    'again with the answer. Never ask the same question twice.',
  ].join('\n');
}

/** The turn for a request, whichever kind it is. */
export function requestPrompt(request: PmRequest): string {
  switch (request.type) {
    case 'INTAKE':
      return intakePrompt(request.goal);
    case 'MESSAGE':
      return messagePrompt(request.text);
    case 'DECIDE':
      return decidePrompt(request);
  }
}

/** How an answer is recorded; it is not a turn of its own (see the file comment). */
export function answeredNote(askId: string, answers: Answer[]): string {
  const said = answers
    .map((answer) => `${answer.questionId}: ${answer.skipped ? '(skipped)' : [...answer.picked, answer.text].filter(Boolean).join(', ')}`)
    .join('; ');
  return `The person answered ask ${askId}: ${said || '(nothing)'}.`;
}

/** The first prompt of a session, and the prompt a restarted session is primed with (§5.4). */
export function primePrompt(input: { runId: string; goal: string; transcript: TranscriptEntry[] }): string {
  const lines = [
    `You are the PM of bdc run ${input.runId}. The run's goal: ${input.goal}`,
    'You talk to the person, write the intake brief, answer their messages and decide on every blocked',
    'phase. You never edit code. The bdc tools are attached to your session: `ask_user`, `submit_brief`,',
    '`reply`, `propose`, `decide`.',
  ];
  if (input.transcript.length > 0) {
    lines.push(
      '',
      'Your previous session was lost. This is the whole conversation so far, so the person sees one',
      'continuous conversation. Continue where it stopped; do not repeat what is already settled.',
      '',
      ...input.transcript.map((entry) => `${entry.from === 'run' ? 'bdc' : 'you'}: ${entry.text}`),
    );
  }
  return lines.join('\n');
}

// ── Submissions → events for the run (§3.4) ────────────────────────────────────────────

const ReplySubmission = z.object({ text: z.string().min(1) });
const ProposalSubmission = z.object({ proposalId: z.string().min(1), text: z.string().min(1), event: PersonEvent });

/**
 * What the PM's submit tool accepted, as the event the run gets. The submit tool follows the request
 * kind: `submit_brief` for intake, `reply` or `propose` for a message, `decide` for a decision.
 * `null` means the submission does not fit the request, which is a failed turn, not a result.
 */
export function submissionToRun(request: PmRequest, submission: unknown): PmToRun | null {
  switch (request.type) {
    case 'INTAKE': {
      const brief = Brief.safeParse(submission);
      return brief.success ? { type: 'PM_BRIEF', brief: brief.data } : null;
    }
    case 'MESSAGE': {
      const proposal = ProposalSubmission.safeParse(submission);
      if (proposal.success) {
        return { type: 'PM_PROPOSAL', proposalId: proposal.data.proposalId, text: proposal.data.text, event: proposal.data.event };
      }
      const reply = ReplySubmission.safeParse(submission);
      return reply.success ? { type: 'PM_REPLY', text: reply.data.text } : null;
    }
    case 'DECIDE': {
      const decision = Decision.safeParse(submission);
      return decision.success ? { type: 'PM_DECISION', scope: request.scope, decision: decision.data } : null;
    }
  }
}

/** The scope a request is about, for the question card the run shows (§6). */
export function requestScope(request: PmRequest | null): string | null {
  return request?.type === 'DECIDE' ? request.scope : null;
}

/** What an agent outcome says, for the transcript. */
function outcomeNote(outcome: AgentOutcome): string {
  if (outcome.status === 'done') {
    return `Submission: ${JSON.stringify(outcome.submission)}`;
  }
  return `Session ended (${outcome.status}): ${outcome.detail}`;
}

function questionsNote(questions: Question[]): string {
  return `Asked the person: ${questions.map((question) => question.title).join(' | ')}`;
}

// ── The machine ────────────────────────────────────────────────────────────────────────

export const pmMachine = setup({
  types: {
    context: {} as PmContext,
    events: {} as PmMachineEvent,
    input: {} as PmInput,
  },
  actors: {
    agent: notProvided('agent'),
    /**
     * Puts the current request into the PM session as a turn. It is an invoked actor, not an entry
     * action, because XState restarts invocations on restore and does not re-run entry actions
     * (§5.7): a PM restored in `thinking` would otherwise wait for an artifact nobody asked for.
     * The agent machine queues a FOLLOW_UP that arrives before its terminal is up, so this cannot
     * be lost while the session starts either.
     */
    deliverRequest: fromCallback<PmMachineEvent, { agentId: string; prompt: string }>(({ input, sendBack }) => {
      sendBack({ type: 'DELIVER_REQUEST', agentId: input.agentId, prompt: input.prompt });
    }),
  },
  guards: {
    /** There is a request waiting for a turn. */
    queued: ({ context }) => context.queue.length > 0,
    /** The current request is still worth retrying after a restart (§5.4: retry once). */
    canRetry: ({ context }) => context.turns < 2,
    /** The agent's submission maps to an event for the run. */
    resultMaps: ({ context, event }) =>
      event.type === 'AGENT_RESULT' &&
      event.outcome.status === 'done' &&
      context.current !== null &&
      submissionToRun(context.current, event.outcome.submission) !== null,
    /** The PM asked the person something. */
    asking: ({ context }) => context.asking !== null,
  },
  actions: {
    /**
     * Starts (or restarts) the PM session. The key is stable for the first session and gets a suffix
     * after a restart, so the daemon launches a new terminal instead of re-attaching (§3.2).
     */
    spawnPmAgent: enqueueActions(({ context, enqueue }) => {
      const key = context.restarts === 0 ? `${context.runId}/pm` : `${context.runId}/pm/${context.restarts}`;
      const id = `pm-agent-${context.restarts}`;
      const job: AgentJob = {
        key,
        role: 'pm',
        agent: context.agent,
        cwd: context.root,
        prompt: primePrompt({ runId: context.runId, goal: context.goal, transcript: context.transcript }),
        // The PM's first artifact is the brief; reply, propose and decide are its other tools (§3.4).
        submit: 'brief',
        timeoutMs: PM_TIMEOUT_MS,
        keepAlive: true,
        labels: { 'bdc.run': context.runId, 'bdc.role': 'pm', 'bdc.key': key },
      };
      enqueue.assign({ agentKey: key, agentId: id });
      enqueue.spawnChild('agent', { id, input: job });
    }),
    stopPmAgent: enqueueActions(({ context, enqueue }) => {
      enqueue.stopChild(context.agentId);
    }),
    /** The run is over: the session's terminal goes with it (§5.5). */
    closePmAgent: enqueueActions(({ context, enqueue }) => {
      enqueue.sendTo(context.agentId, { type: 'CLOSE' });
    }),
    /** A trust or permission prompt of the PM's own session is the person's to answer (§3.3). */
    forwardNeedsYou: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'AGENT_NEEDS_YOU' || event.key !== context.agentKey) return;
      enqueue.sendParent({ type: 'AGENT_NEEDS_YOU', key: event.key, prompt: event.prompt, choices: event.choices });
    }),
    /** The person's choice becomes keys in the session, once the key names this session (§3.3). */
    forwardPromptChoice: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'PROMPT_CHOICE' || event.agentKey !== context.agentKey) return;
      enqueue.sendTo(context.agentId, { type: 'PROMPT_CHOICE', choice: event.choice });
    }),
    countRestart: assign({ restarts: ({ context }) => context.restarts + 1 }),
    countTurn: assign({ turns: ({ context }) => context.turns + 1 }),
    enqueueRequest: assign({
      queue: ({ context, event }) => {
        if (event.type === 'CLOSE') return context.queue;
        const id = `req-${context.requests + 1}`;
        return [...context.queue, { ...event, id } as PmRequest];
      },
      requests: ({ context, event }) => (event.type === 'CLOSE' ? context.requests : context.requests + 1),
    }),
    takeRequest: assign(({ context }) => ({
      current: context.queue[0] ?? null,
      queue: context.queue.slice(1),
      turns: 1,
    })),
    recordRequest: assign({
      transcript: ({ context }) =>
        context.current === null
          ? context.transcript
          : [...context.transcript, { from: 'run', text: requestPrompt(context.current) }],
    }),
    recordAnswer: assign({
      transcript: ({ context, event }) =>
        event.type === 'ANSWER'
          ? [...context.transcript, { from: 'run', text: answeredNote(event.askId, event.answers) }]
          : context.transcript,
    }),
    recordResult: assign({
      transcript: ({ context, event }) =>
        event.type === 'AGENT_RESULT'
          ? [...context.transcript, { from: 'pm', text: outcomeNote(event.outcome) }]
          : context.transcript,
    }),
    recordAsking: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'AGENT_ASKING') return;
      enqueue.assign({
        asking: { askId: event.askId, scope: requestScope(context.current) },
        transcript: [...context.transcript, { from: 'run', text: questionsNote(event.questions) }],
      });
    }),
    clearAsking: assign({ asking: null }),
    finishRequest: assign({ current: null, turns: 0 }),
    recordFailure: assign({
      failure: ({ event }) => (event.type === 'AGENT_RESULT' && event.outcome.status !== 'done' ? event.outcome.detail : 'the PM produced no result'),
    }),
    /** Sends the current request into the PM session as a turn (and again after a restart). */
    sendRequestToAgent: enqueueActions(({ event, enqueue }) => {
      if (event.type !== 'DELIVER_REQUEST') return;
      enqueue.sendTo(event.agentId, { type: 'FOLLOW_UP', prompt: event.prompt });
    }),
    sendResultToRun: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'AGENT_RESULT' || event.outcome.status !== 'done' || context.current === null) return;
      const mapped = submissionToRun(context.current, event.outcome.submission);
      if (mapped !== null) enqueue.sendParent(mapped);
    }),
    sendAskingToRun: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'AGENT_ASKING') return;
      enqueue.sendParent({
        type: 'PM_ASKING',
        scope: requestScope(context.current),
        askId: event.askId,
        questions: event.questions,
      });
    }),
    /** The answer arrived through the MCP `ask_user` call, so the run's question card can go. */
    sendAskDone: enqueueActions(({ context, enqueue }) => {
      if (context.asking === null) return;
      enqueue.sendParent({ type: 'PM_ASK_DONE', askId: context.asking.askId });
    }),
    /** The same, for an `ANSWER`: the daemon resolved that ask, so the card can go now. */
    sendAnswered: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'ANSWER') return;
      enqueue.assign({ asking: context.asking?.askId === event.askId ? null : context.asking });
      enqueue.sendParent({ type: 'PM_ASK_DONE', askId: event.askId });
    }),
    sendFailedToRun: enqueueActions(({ context, enqueue }) => {
      enqueue.sendParent({ type: 'PM_FAILED', detail: context.failure ?? 'the PM session failed twice' });
    }),
  },
}).createMachine({
  id: 'pm',
  context: ({ input }) => ({
    runId: input.runId,
    root: input.root,
    agent: input.agent,
    goal: input.goal,
    agentKey: '',
    agentId: '',
    transcript: [],
    queue: [],
    current: null,
    turns: 0,
    restarts: 0,
    requests: 0,
    asking: null,
    failure: null,
  }),
  initial: 'starting',
  // An answer is never a turn: wherever it arrives it is recorded and the ask is reported done.
  on: {
    ANSWER: { actions: ['recordAnswer', 'sendAnswered'] },
    // The run closed the session: the agent closes its terminal, so nothing is left behind (§5.5).
    CLOSE: { actions: 'closePmAgent' },
    // The PM's own prompt cards: the run shows them, the person answers with PROMPT_CHOICE (§3.3).
    AGENT_NEEDS_YOU: { actions: 'forwardNeedsYou' },
    PROMPT_CHOICE: { actions: 'forwardPromptChoice' },
  },
  states: {
    /** The PM session is coming up: new, or primed from the transcript. */
    starting: {
      entry: 'spawnPmAgent',
      always: { target: 'idle' },
    },

    idle: {
      always: [{ guard: 'queued', target: 'thinking', actions: ['takeRequest', 'recordRequest'] }],
      on: {
        INTAKE: { actions: 'enqueueRequest' },
        MESSAGE: { actions: 'enqueueRequest' },
        DECIDE: { actions: 'enqueueRequest' },
      },
    },

    /** One PM turn: the request went into the session and its artifact is on the way. */
    thinking: {
      invoke: {
        id: 'deliverRequest',
        src: 'deliverRequest',
        input: ({ context }) => ({
          agentId: context.agentId,
          prompt: context.current === null ? '' : requestPrompt(context.current),
        }),
      },
      on: {
        DELIVER_REQUEST: { actions: 'sendRequestToAgent' },
        INTAKE: { actions: 'enqueueRequest' },
        MESSAGE: { actions: 'enqueueRequest' },
        DECIDE: { actions: 'enqueueRequest' },
        AGENT_RESULT: [
          { guard: 'resultMaps', target: 'idle', actions: ['recordResult', 'sendResultToRun', 'finishRequest'] },
          // Session lost or no artifact: restart once, primed from the transcript (§5.4).
          { guard: 'canRetry', target: 'restarting', actions: ['recordResult', 'recordFailure', 'countTurn'] },
          { target: 'idle', actions: ['recordResult', 'recordFailure', 'sendFailedToRun', 'finishRequest'] },
        ],
        AGENT_ASKING: { actions: ['recordAsking', 'sendAskingToRun'] },
        AGENT_ASK_DONE: [{ guard: 'asking', actions: ['sendAskDone', 'clearAsking'] }],
      },
    },

    /** A new session primed with the transcript; the current request is retried once. */
    restarting: {
      entry: ['stopPmAgent', 'countRestart', 'spawnPmAgent'],
      // `thinking`'s entry sends the request into the new session.
      always: { target: 'thinking' },
    },
  },
});
