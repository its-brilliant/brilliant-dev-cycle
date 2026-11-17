/**
 * The real hc effects for agent jobs (spec §3.2, §3.3, §5.5): launch an agent in a hidden hc
 * terminal, observe it, send to it, and close it.
 *
 * Every hc call goes through one binary (`hcBin`, default `hc`), so the tests point it at a fake
 * and the suite never reaches the person's Herdr app (§12). The per-CLI command line and the MCP
 * submit tools are not this module's business: `commandFor` supplies the argv and env of one job.
 *
 * Two things live outside machine context on purpose (§5.7): the prompt registry (label → keys for
 * a terminal the observer last saw a prompt on, so `sendToAgent` can press the keys for the words
 * the person picked) and the delivered inbox sequence, which is a file, so a restarted observer
 * does not deliver a submission twice.
 *
 * The observer also carries the question tool (§3.4): `ask_user` appends to the job's
 * `asks.jsonl` and the observer turns each new ask into one `OBS_ASKING`, counting what it already
 * reported in `asks-reported` so a restart does not ask the person the same thing twice.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromCallback, fromPromise } from 'xstate';
import type { CallbackActorLogic, PromiseActorLogic } from 'xstate';
import type {
  AgentJob,
  CloseAgentInput,
  LaunchAgentInput,
  LaunchAgentOutput,
  ObserveAgentInput,
  SendToAgentInput,
} from '../contracts/actors.js';
import type { AgentObservation } from '../contracts/events.js';
import { AGENT_ENV, agentDir, deliveredFile, inboxFile, InboxEntry } from '../contracts/inbox.js';
import { askNumber, asksFile, readAsks, readReported, reportedFile, writeReported } from '../agents/asks.js';
import { observationsFromHcEvents } from '../hc/observations.js';
import { detectPrompt, type DetectedPrompt, type PromptChoice } from './prompts-on-screen.js';

/** `bin/bdc-adapt`, the launch marker every agent terminal goes through (§3.2). */
export const BDC_ADAPT = fileURLToPath(new URL('../../bin/bdc-adapt', import.meta.url));

/** What a job's CLI is run with. The per-CLI adapters (§3.1) supply this; hc does not care. */
export interface AgentCommand {
  argv: string[];
  env: Record<string, string>;
}

export interface HcEffectsOptions {
  /** The hc binary. Tests pass a fake so the suite never talks to the real Herdr app. */
  hcBin?: string;
  commandFor: (job: AgentJob) => AgentCommand;
  /** How often the observer reads the screen and the inbox. */
  pollMs?: number;
  /** Project root, for the job's directory under `.herd/runs/<run>/agents/<key>`. */
  root: string;
  runId: string;
}

export interface HcEffects {
  launchAgent: PromiseActorLogic<LaunchAgentOutput, LaunchAgentInput>;
  observeAgent: CallbackActorLogic<AgentObservation, ObserveAgentInput>;
  sendToAgent: PromiseActorLogic<void, SendToAgentInput>;
  closeAgent: PromiseActorLogic<void, CloseAgentInput>;
}

/**
 * The choices the observer last saw on a terminal's screen, by terminal. `sendToAgent` presses the
 * keys for a label, so the words the person clicked in PM chat never reach the agent's CLI.
 */
const promptChoices = new Map<string, PromptChoice[]>();

// ── running hc ─────────────────────────────────────────────────────────────────────────────

interface HcRun {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Last line or two of a command's output: enough for a person to see what hc said. */
function tail(text: string): string {
  const lines = text.trim().split('\n').filter((line) => line.trim() !== '');
  return lines.length === 0 ? '(no output)' : lines.slice(-3).join(' | ');
}

function spawnHc(hcBin: string, args: string[]): Promise<HcRun> {
  return new Promise((resolve) => {
    const child = spawn(hcBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => resolve({ code: null, stdout, stderr, error }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** One hc command that has to succeed. A missing hc is a message a person can act on, not a stack. */
async function hcText(hcBin: string, args: string[], what: string): Promise<string> {
  const result = await spawnHc(hcBin, args);
  if (result.error !== undefined) {
    throw new Error(`hc is not installed or not runnable (${hcBin}): ${result.error.message}`);
  }
  if (result.code !== 0) {
    throw new Error(`hc ${what} failed (exit ${result.code}): ${tail(result.stderr)}`);
  }
  return result.stdout;
}

/** The `address` of the last JSON line hc printed. */
function addressIn(stdout: string): string | null {
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const address = (parsed as { address?: unknown }).address;
      if (typeof address === 'string' && address !== '') return address;
    } catch {
      // Not the line we are after; hc may print a warning before its JSON.
    }
  }
  return null;
}

/** A live terminal already labelled with this job key, or null (§3.2: launch is idempotent). */
/**
 * Close every hc terminal of a run, live or finished (spec §5.5: nothing is left behind). The daemon
 * calls this when a run is done or cancelled, whatever its machines managed to close first.
 */
export async function closeRunTerminals(runId: string, hcBin = 'hc'): Promise<string[]> {
  const listed = await spawnHc(hcBin, ['ls', '--json', '--all', '--label', `bdc.run=${runId}`]);
  if (listed.error !== undefined || listed.code !== 0) return [];
  let terminals: unknown;
  try {
    terminals = (JSON.parse(listed.stdout) as { terminals?: unknown }).terminals;
  } catch {
    return [];
  }
  if (!Array.isArray(terminals)) return [];
  const closed: string[] = [];
  for (const terminal of terminals) {
    const address = (terminal as { address?: unknown }).address;
    if (typeof address !== 'string' || address === '') continue;
    await spawnHc(hcBin, ['kill', address]);
    await spawnHc(hcBin, ['rm', address]);
    closed.push(address);
  }
  return closed;
}

async function liveTerminal(hcBin: string, key: string): Promise<string | null> {
  const stdout = await hcText(hcBin, ['ls', '--json', '--label', `bdc.key=${key}`], 'ls');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`hc ls did not print JSON: ${tail(stdout)}`);
  }
  const terminals = (parsed as { terminals?: unknown }).terminals;
  if (!Array.isArray(terminals)) return null;
  for (const terminal of terminals) {
    if (typeof terminal !== 'object' || terminal === null) continue;
    const { address, state } = terminal as { address?: unknown; state?: unknown };
    if (typeof address === 'string' && address !== '' && state !== 'finished') return address;
  }
  return null;
}

/** `--label k=v` for every label of the job, and `bdc.key` so the observer can find it again. */
function labelArgs(job: AgentJob): string[] {
  const labels = { ...job.labels, 'bdc.key': job.key };
  return Object.entries(labels).flatMap(([name, value]) => ['--label', `${name}=${value}`]);
}

/** hc has no `--env`, so the agent's environment goes through `env K=V ...` in the argv. */
function envArgs(job: AgentJob, root: string, runId: string, env: Record<string, string>): string[] {
  const all = {
    ...env,
    [AGENT_ENV.root]: root,
    [AGENT_ENV.run]: runId,
    [AGENT_ENV.key]: job.key,
    [AGENT_ENV.role]: job.role,
    [AGENT_ENV.submit]: job.submit,
  };
  return Object.entries(all).map(([name, value]) => `${name}=${value}`);
}

// ── the inbox ─────────────────────────────────────────────────────────────────────────────

function readDelivered(file: string): number {
  try {
    const seq = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(seq) && seq > 0 ? seq : 0;
  } catch {
    return 0;
  }
}

/** One line of the inbox, or null for a line that is not an InboxEntry (a half-written tail). */
function parseEntry(line: string): InboxEntry | null {
  try {
    const parsed = InboxEntry.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ── the effects ───────────────────────────────────────────────────────────────────────────

/** Every effect the agent machine invokes, against real hc. Pass to `agentMachine.provide({ actors })`. */
export function hcEffects(options: HcEffectsOptions): HcEffects {
  const hcBin = options.hcBin ?? 'hc';
  const pollMs = options.pollMs ?? 1000;
  const { root, runId, commandFor } = options;

  return {
    launchAgent: fromPromise<LaunchAgentOutput, LaunchAgentInput>(async ({ input }) => {
      const { job } = input;
      const live = await liveTerminal(hcBin, job.key);
      if (live !== null) return { terminal: live, reattached: true };

      // The job's directory holds its inbox; the submit tool writes there, so it must exist first.
      fs.mkdirSync(agentDir(root, runId, job.key), { recursive: true });
      const { argv, env } = commandFor(job);
      const stdout = await hcText(
        hcBin,
        [
          'run',
          '--bg',
          '--json',
          // §3.2: an agent terminal is never placed in a Herdr space or tab, and never notifies.
          '--no-parent',
          '--no-notify',
          '--cwd',
          job.cwd,
          ...labelArgs(job),
          '--',
          'env',
          ...envArgs(job, root, runId, env),
          BDC_ADAPT,
          ...argv,
        ],
        'run',
      );
      const terminal = addressIn(stdout);
      if (terminal === null) throw new Error(`hc run did not report a terminal address: ${tail(stdout)}`);
      return { terminal, reattached: false };
    }),

    observeAgent: fromCallback<AgentObservation, ObserveAgentInput>(({ input, sendBack }) => {
      const { job, terminal } = input;
      const dir = agentDir(root, runId, job.key);
      const inbox = inboxFile(dir);
      const delivered = deliveredFile(dir);
      const asks = asksFile(dir);
      const reported = reportedFile(dir);
      // Read on start, not remembered: a restored observer must not deliver a submission twice, nor
      // report the same ask twice (§5.7).
      let highestDelivered = readDelivered(delivered);
      let highestReported = readReported(reported);
      let prompt: DetectedPrompt | null = null;
      let exited = false;
      let stopped = false;
      let reading = false;

      /** Turn every inbox entry the submit tool appended since the last delivery into OBS_SUBMITTED. */
      const deliverInbox = (): void => {
        let text: string;
        try {
          text = fs.readFileSync(inbox, 'utf8');
        } catch {
          return;
        }
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue;
          const entry = parseEntry(line);
          if (entry === null || entry.seq <= highestDelivered) continue;
          highestDelivered = entry.seq;
          sendBack({ type: 'OBS_SUBMITTED', submission: entry.submission });
          try {
            fs.writeFileSync(delivered, `${entry.seq}\n`);
          } catch {
            // The delivery is what matters; a lost seq costs one duplicate on a restore.
          }
        }
      };

      /** Every ask the question tool filed since the last report becomes one OBS_ASKING (§3.4). */
      const deliverAsks = (): void => {
        for (const entry of readAsks(asks)) {
          const number = askNumber(entry.askId);
          if (number <= highestReported) continue;
          highestReported = number;
          sendBack({ type: 'OBS_ASKING', askId: entry.askId, questions: entry.questions });
          writeReported(reported, number);
        }
      };

      const deliver = (): void => {
        deliverInbox();
        deliverAsks();
      };

      const feed = (line: string): void => {
        for (const observation of observationsFromHcEvents([line], terminal)) {
          if (observation.type === 'OBS_EXITED') exited = true;
          sendBack(observation);
        }
      };

      /** The exit code of a terminal that is finished, `null` when it was killed, undefined when live. */
      const exitCode = async (): Promise<number | null | undefined> => {
        const result = await spawnHc(hcBin, ['get', terminal, '--json']);
        if (result.error !== undefined || result.code !== 0) return undefined;
        try {
          const parsed = JSON.parse(result.stdout) as { exit_code?: unknown; state?: unknown };
          if (parsed.state !== 'finished') return undefined;
          return typeof parsed.exit_code === 'number' ? parsed.exit_code : null;
        } catch {
          return undefined;
        }
      };

      /**
       * The event stream ended. When the terminal is finished too, that is the exit; when hc itself
       * went away, the terminal is still there and the next observer start will re-attach.
       */
      const onEventsEnded = async (): Promise<void> => {
        if (stopped || exited) return;
        const code = await exitCode();
        if (stopped || exited || code === undefined) return;
        exited = true;
        sendBack({ type: 'OBS_EXITED', code });
      };

      /** A prompt that appears is `needsYou`; a prompt that went away means the agent is working again. */
      const readScreen = async (): Promise<void> => {
        const result = await spawnHc(hcBin, ['read', terminal]);
        if (stopped || result.error !== undefined || result.code !== 0) return;
        const detected = detectPrompt(result.stdout);
        if (detected === null) {
          if (prompt === null) return;
          prompt = null;
          promptChoices.delete(terminal);
          sendBack({ type: 'OBS_PROMPT_CLEARED' });
          return;
        }
        const same =
          prompt !== null &&
          prompt.prompt === detected.prompt &&
          prompt.choices.map((choice) => choice.label).join('\u0000') ===
            detected.choices.map((choice) => choice.label).join('\u0000');
        prompt = detected;
        promptChoices.set(terminal, detected.choices);
        if (same) return;
        sendBack({ type: 'OBS_PROMPT', prompt: detected.prompt, choices: detected.choices.map((choice) => choice.label) });
      };

      const poll = async (): Promise<void> => {
        if (stopped || reading) return;
        reading = true;
        try {
          deliver();
          await readScreen();
        } finally {
          reading = false;
        }
      };

      const events = spawn(hcBin, ['events', '--json', '--label', `bdc.key=${job.key}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buffered = '';
      events.stdout?.setEncoding('utf8');
      events.stdout?.on('data', (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) feed(line);
      });
      // hc's complaints are not observations: the machine's rules come from status, submission, exit.
      events.stderr?.on('data', () => undefined);
      events.on('error', () => undefined);
      events.on('close', () => {
        void onEventsEnded();
      });

      let watcher: fs.FSWatcher | null = null;
      try {
        watcher = fs.watch(dir, () => deliver());
        watcher.on('error', () => {
          watcher?.close();
          watcher = null;
        });
      } catch {
        // The poll below still finds the entry; the watcher only makes it immediate.
        watcher = null;
      }

      deliver();
      const timer = setInterval(() => {
        void poll();
      }, pollMs);
      void poll();

      return () => {
        stopped = true;
        clearInterval(timer);
        watcher?.close();
        events.kill('SIGTERM');
      };
    }),

    sendToAgent: fromPromise<void, SendToAgentInput>(async ({ input }) => {
      if (input.keys !== undefined) {
        const choices = promptChoices.get(input.terminal);
        const keys: string[] = [];
        for (const label of input.keys) {
          const choice = choices?.find((candidate) => candidate.label === label);
          if (choice === undefined) {
            throw new Error(`the agent is not waiting on a prompt with the choice ${JSON.stringify(label)}`);
          }
          keys.push(...choice.keys);
        }
        await hcText(hcBin, ['keys', input.terminal, ...keys], 'keys');
        return;
      }
      if (input.text !== undefined) {
        await hcText(hcBin, ['send', input.terminal, input.text], 'send');
      }
    }),

    closeAgent: fromPromise<void, CloseAgentInput>(async ({ input }) => {
      promptChoices.delete(input.terminal);
      // Idempotent (§5.5): a terminal that is already gone is a terminal that is closed.
      if (input.terminal === '') return;
      await spawnHc(hcBin, ['kill', input.terminal]);
      await spawnHc(hcBin, ['rm', input.terminal]);
    }),
  };
}
