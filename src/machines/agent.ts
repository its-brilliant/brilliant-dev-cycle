/**
 * `agentMachine`: one agent job (spec §5.5) and the rules that decide it is finished (§3.3).
 *
 * Everything outside the machine is a named actor (`launchAgent`, `observeAgent`, `sendToAgent`,
 * `closeAgent`); the daemon supplies the real ones, tests supply stubs. Time comes from `after`
 * delays only: `roleTimeout` from `job.timeoutMs`, `emptyGrace` 20 s.
 *
 * Restore (§5.7): XState re-runs an invocation whose promise was still pending, and restarts
 * callback actors; a promise that already settled is restored as done. So a snapshot taken in
 * `launching` re-runs `launchAgent`, which re-attaches to a live terminal with the same
 * `job.key` instead of starting a second agent (§3.2); a later snapshot restores that launch and
 * `observeAgent` restarts on the terminal the context kept. No entry action runs twice, so no
 * `AGENT_RESULT` is reported twice.
 */
import { assign, fromCallback, fromPromise, sendParent, setup } from 'xstate';
import type { DoneActorEvent, ErrorActorEvent } from 'xstate';
import type {
  AgentJob,
  CloseAgentInput,
  LaunchAgentInput,
  LaunchAgentOutput,
  ObserveAgentInput,
  SendToAgentInput,
  SubmitKind,
} from '../contracts/actors.js';
import type { AgentObservation, AgentToParent, ParentToAgent } from '../contracts/events.js';
import type { Question } from '../contracts/domain.js';

/** §3.3: an agent that settled without a result gets 20 s, then one nudge, then 20 s more. */
const EMPTY_GRACE_MS = 20_000;

/** The submit tool of each job kind (§3.4); the nudge has to name the tool the agent must call. */
const SUBMIT_TOOL: Record<SubmitKind, string> = {
  brief: 'submit_brief',
  reply: 'reply',
  decision: 'decide',
  spec: 'submit_spec',
  plan: 'submit_plan',
  task: 'report_task',
  findings: 'submit_findings',
  proof: 'submit_proof',
};

function nudgeText(job: AgentJob): string {
  return `You have not finished: bdc has no result from you. Call the ${SUBMIT_TOOL[job.submit]} tool now with your result.`;
}

/** Everything the machine knows about the job. Plain JSON: it is persisted (§5.7). */
export interface AgentContext {
  job: AgentJob;
  /** hc terminal of this job; `''` until `launchAgent` reports one. */
  terminal: string;
  /** What the submit tool accepted, or null before it does. */
  submission: unknown;
  /** Last status the agent's own app reported; `bdc` launch markers are not the agent. */
  agentState: string | null;
  /** The agent reported its own `working` at least once (§3.3 startup idle). */
  sawAgentWorking: boolean;
  /** The one nudge of §5.5 has been sent. */
  nudged: boolean;
  /** What `sending` hands to `sendToAgent`. */
  pendingSend: SendToAgentInput | null;
  /** How the terminal ended, for the `crashed` detail. */
  exitCode: number | null;
  /** Why launching failed, for the `failed` detail. */
  launchError: string | null;
}

/** What the machine reads: the observer, its parent, and the two events `launchAgent` raises. */
export type AgentMachineEvent =
  | AgentObservation
  | ParentToAgent
  | DoneActorEvent<LaunchAgentOutput, 'launch'>
  | ErrorActorEvent<unknown, 'launch'>;

export const agentMachine = setup({
  types: {
    context: {} as AgentContext,
    events: {} as AgentMachineEvent,
    input: {} as AgentJob,
  },
  actors: {
    launchAgent: fromPromise<LaunchAgentOutput, LaunchAgentInput>(async () => {
      throw new Error('launchAgent not provided');
    }),
    observeAgent: fromCallback<AgentObservation, ObserveAgentInput>(() => {
      throw new Error('observeAgent not provided');
    }),
    sendToAgent: fromPromise<void, SendToAgentInput>(async () => {
      throw new Error('sendToAgent not provided');
    }),
    closeAgent: fromPromise<void, CloseAgentInput>(async () => {
      throw new Error('closeAgent not provided');
    }),
  },
  delays: {
    roleTimeout: ({ context }) => context.job.timeoutMs,
    emptyGrace: EMPTY_GRACE_MS,
  },
  guards: {
    /** §3.3: the agent's own app says it is working. */
    agentWorking: ({ event }) => event.type === 'OBS_STATUS' && event.app !== 'bdc' && event.state === 'working',
    /** §3.3: it worked at least once, then settled, and nothing was submitted. */
    agentSettled: ({ context, event }) =>
      event.type === 'OBS_STATUS' &&
      event.app !== 'bdc' &&
      (event.state === 'idle' || event.state === 'done') &&
      context.sawAgentWorking &&
      context.submission === null,
    /** §3.3: a result was accepted and the agent's last own status is not `working`. */
    finishedOnStatus: ({ context, event }) =>
      context.submission !== null && event.type === 'OBS_STATUS' && event.app !== 'bdc' && event.state !== 'working',
    /** §3.3: the submission is the event, so judge by the last status the agent itself reported. */
    agentNotWorking: ({ context }) => context.agentState !== 'working',
    submissionAccepted: ({ context }) => context.submission !== null,
    settledWithoutSubmission: ({ context }) => context.sawAgentWorking && context.submission === null,
    nudged: ({ context }) => context.nudged,
    notKeepAlive: ({ context }) => !context.job.keepAlive,
  },
  actions: {
    recordTerminal: assign({
      terminal: ({ event }) => (event.type === 'xstate.done.actor.launch' ? event.output.terminal : ''),
    }),
    recordLaunchError: assign({
      launchError: ({ event }) => (event.type === 'xstate.error.actor.launch' ? String(event.error) : 'launch failed'),
    }),
    /** `bdc` is the adapter's launch marker, not the agent (the v1 pi bug): it says nothing. */
    recordAgentStatus: assign(({ context, event }) => {
      if (event.type !== 'OBS_STATUS' || event.app === 'bdc') return context;
      return {
        ...context,
        agentState: event.state,
        sawAgentWorking: context.sawAgentWorking || event.state === 'working',
      };
    }),
    recordSubmission: assign({
      submission: ({ event }) => (event.type === 'OBS_SUBMITTED' ? event.submission : null),
    }),
    recordExit: assign({
      exitCode: ({ event }) => (event.type === 'OBS_EXITED' ? event.code : null),
    }),
    recordNudge: assign({ nudged: true }),
    recordFollowUp: assign(({ context, event }) =>
      event.type === 'FOLLOW_UP'
        ? { ...context, submission: null, pendingSend: { terminal: context.terminal, text: event.prompt } }
        : context,
    ),
    recordPromptChoice: assign(({ context, event }) =>
      event.type === 'PROMPT_CHOICE'
        ? { ...context, pendingSend: { terminal: context.terminal, keys: [event.choice] } }
        : context,
    ),
    clearPendingSend: assign({ pendingSend: null }),
    reportDone: sendParent(({ context }): AgentToParent => ({
      type: 'AGENT_RESULT',
      key: context.job.key,
      outcome: { status: 'done', submission: context.submission },
    })),
    reportAsking: sendParent(
      ({ context }, params: { askId: string; questions: Question[] }): AgentToParent => ({
        type: 'AGENT_ASKING',
        key: context.job.key,
        askId: params.askId,
        questions: params.questions,
      }),
    ),
    reportAskDone: sendParent(
      ({ context }, params: { askId: string }): AgentToParent => ({
        type: 'AGENT_ASK_DONE',
        key: context.job.key,
        askId: params.askId,
      }),
    ),
    reportNeedsYou: sendParent(
      ({ context }, params: { prompt: string; choices: string[] }): AgentToParent => ({
        type: 'AGENT_NEEDS_YOU',
        key: context.job.key,
        prompt: params.prompt,
        choices: params.choices,
      }),
    ),
    reportEmpty: sendParent(({ context }): AgentToParent => ({
      type: 'AGENT_RESULT',
      key: context.job.key,
      outcome: {
        status: 'empty',
        detail: `the agent settled without calling ${SUBMIT_TOOL[context.job.submit]}`,
      },
    })),
    reportCrashed: sendParent(({ context }): AgentToParent => ({
      type: 'AGENT_RESULT',
      key: context.job.key,
      outcome: {
        status: 'crashed',
        detail:
          context.exitCode === null
            ? 'the agent terminal ended before a result was submitted'
            : `the agent terminal ended with code ${context.exitCode} before a result was submitted`,
      },
    })),
    reportTimedOut: sendParent(({ context }): AgentToParent => ({
      type: 'AGENT_RESULT',
      key: context.job.key,
      outcome: { status: 'timedOut', detail: `no result within ${context.job.timeoutMs} ms` },
    })),
    reportFailed: sendParent(({ context }): AgentToParent => ({
      type: 'AGENT_RESULT',
      key: context.job.key,
      outcome: { status: 'failed', detail: context.launchError ?? 'the agent terminal could not be started' },
    })),
  },
}).createMachine({
  id: 'agent',
  context: ({ input }) => ({
    job: input,
    terminal: '',
    submission: null,
    agentState: null,
    sawAgentWorking: false,
    nudged: false,
    pendingSend: null,
    exitCode: null,
    launchError: null,
  }),
  initial: 'launching',
  states: {
    launching: {
      invoke: {
        src: 'launchAgent',
        id: 'launch',
        input: ({ context }): LaunchAgentInput => ({ job: context.job }),
        onDone: { target: 'running', actions: 'recordTerminal' },
        onError: { target: 'failed', actions: 'recordLaunchError' },
      },
      on: { CLOSE: { target: 'closing' } },
    },
    running: {
      // Restarts whenever `running` is re-entered (a nudge, a follow-up, a restore), so the
      // observer must be safe to attach to the same terminal again (§5.7).
      invoke: {
        src: 'observeAgent',
        input: ({ context }): ObserveAgentInput => ({ job: context.job, terminal: context.terminal }),
      },
      initial: 'active',
      on: {
        // A result already accepted is still a result: the agent cannot work any more.
        OBS_EXITED: [
          { guard: 'submissionAccepted', target: 'done' },
          { target: 'crashed', actions: 'recordExit' },
        ],
        CLOSE: { target: 'closing' },
      },
      states: {
        active: {
          initial: 'working',
          // The role timeout only runs while the agent is neither asking nor waiting for you.
          after: { roleTimeout: { target: '#agent.timedOut' } },
          on: {
            OBS_STATUS: [
              { guard: 'finishedOnStatus', target: '#agent.done', actions: 'recordAgentStatus' },
              { guard: 'agentSettled', target: '.settled', actions: 'recordAgentStatus' },
              { guard: 'agentWorking', target: '.working', actions: 'recordAgentStatus' },
              { actions: 'recordAgentStatus' },
            ],
            OBS_SUBMITTED: [
              { guard: 'agentNotWorking', target: '#agent.done', actions: 'recordSubmission' },
              { actions: 'recordSubmission' },
            ],
            OBS_ASKING: {
              target: 'askingYou',
              actions: {
                type: 'reportAsking',
                params: ({ event }) => ({ askId: event.askId, questions: event.questions }),
              },
            },
            OBS_PROMPT: {
              target: 'needsYou',
              actions: { type: 'reportNeedsYou', params: ({ event }) => ({ prompt: event.prompt, choices: event.choices }) },
            },
          },
          states: {
            working: {},
            /** Settled without a result; `emptyGrace` restarts on every new settle. */
            settled: {
              after: {
                emptyGrace: [
                  { guard: 'nudged', target: '#agent.closing', actions: 'reportEmpty' },
                  { guard: 'settledWithoutSubmission', target: '#agent.empty', actions: 'recordNudge' },
                ],
              },
            },
          },
        },
        /** Sends a follow-up or the keys for a prompt choice. Observation events are not read here. */
        sending: {
          invoke: {
            src: 'sendToAgent',
            id: 'send',
            input: ({ context }): SendToAgentInput => context.pendingSend ?? { terminal: context.terminal },
            onDone: { target: 'active', actions: 'clearPendingSend' },
            // A failed paste does not kill the job: the observation rules still see what the
            // agent does next (and the empty grace or the role timeout still ends the job).
            onError: { target: 'active', actions: 'clearPendingSend' },
          },
        },
        askingYou: {
          on: {
            OBS_ASK_DONE: {
              target: 'active',
              actions: { type: 'reportAskDone', params: ({ event }) => ({ askId: event.askId }) },
            },
          },
        },
        needsYou: {
          on: {
            PROMPT_CHOICE: { target: 'sending', actions: 'recordPromptChoice' },
            OBS_PROMPT_CLEARED: { target: 'active' },
          },
        },
      },
    },
    done: {
      entry: 'reportDone',
      // Without keepAlive there is nothing left to do; with it the session waits for FOLLOW_UP.
      always: [{ guard: 'notKeepAlive', target: 'closing' }],
      on: {
        FOLLOW_UP: { target: 'running.sending', actions: 'recordFollowUp' },
        CLOSE: { target: 'closing' },
      },
    },
    /** First empty: nudge once, naming the submit tool, and keep the job running (§5.5). */
    empty: {
      invoke: {
        src: 'sendToAgent',
        id: 'nudge',
        input: ({ context }): SendToAgentInput => ({ terminal: context.terminal, text: nudgeText(context.job) }),
        // Still settled: the grace runs again, and a second settle without a result is empty.
        onDone: { target: 'running.active.settled' },
        onError: { target: 'closing', actions: 'reportEmpty' },
      },
      on: { CLOSE: { target: 'closing' } },
    },
    crashed: {
      entry: 'reportCrashed',
      always: { target: 'closing' },
    },
    timedOut: {
      entry: 'reportTimedOut',
      always: { target: 'closing' },
    },
    failed: {
      entry: 'reportFailed',
      always: { target: 'closing' },
    },
    closing: {
      // CLOSE can arrive before `launching` reported a terminal; there is nothing to close then.
      invoke: {
        src: 'closeAgent',
        id: 'close',
        input: ({ context }): CloseAgentInput => ({ terminal: context.terminal }),
        onDone: { target: 'closed' },
        onError: { target: 'closed' },
      },
    },
    closed: { type: 'final' },
  },
});
