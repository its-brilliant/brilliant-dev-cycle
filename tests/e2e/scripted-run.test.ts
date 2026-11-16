import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectConfig } from '../../src/contracts/domain.js';
import { connect, newRequestId, type DaemonClient } from '../../src/daemon/client.js';
import { projectPaths } from '../../src/daemon/paths.js';
import { ProjectRuns, type ProjectRunsOptions } from '../../src/daemon/runs.js';
import { startDaemon, type Daemon } from '../../src/daemon/server.js';
import type { JsonValue } from '../../src/daemon/store.js';
import { scriptedActors, scriptedCloses, scriptedLaunches, scriptedSends } from '../../src/effects/scripted.js';

const AGENT = { cli: 'pi', model: '' };
const CONFIG = ProjectConfig.parse({
  agents: { pm: AGENT, specWriter: AGENT, planner: AGENT, builder: AGENT, reviewer: AGENT, verifier: AGENT },
  lenses: { security: { block_on: 'high' } },
  verification: { parallel: 1, checks: [{ name: 'tests', run: 'echo ok' }] },
  concurrency: 2,
});

const GOAL = 'Add a health check endpoint';
/** Slow enough that a person's events land in the stage they belong to. */
const DELAY_MS = 20;

/** A view as the daemon streams it: the projection, plus the host's own error field. */
type View = Record<string, JsonValue> & { stage?: string };

/** Collects the views of one subscription, so a stage that was passed quickly is not missed. */
class Watcher {
  readonly views: View[] = [];
  readonly #waiters: Array<{ predicate: (view: View) => boolean; resolve: (view: View) => void }> = [];

  push(view: View): void {
    this.views.push(view);
    for (const waiter of [...this.#waiters]) {
      if (!waiter.predicate(view)) continue;
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve(view);
    }
  }

  /** The first view (already seen or still to come) that matches. */
  until(predicate: (view: View) => boolean, what: string, timeoutMs = 8_000): Promise<View> {
    const seen = this.views.find(predicate);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.#waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        const stages = [...new Set(this.views.map((view) => view.stage))].join(', ');
        const last = this.views[this.views.length - 1];
        const why = last?.error === undefined || last.error === null ? '' : `; the run says: ${String(last.error)}`;
        reject(new Error(`timed out waiting for ${what}; saw stages: ${stages}${why}`));
      }, timeoutMs);
      const done = waiter.resolve;
      waiter.resolve = (view) => {
        clearTimeout(timer);
        done(view);
      };
    });
  }

  stage(stage: string): Promise<View> {
    return this.until((view) => view.stage === stage, `stage ${stage}`);
  }
}

let root: string;
let runs: ProjectRuns | undefined;
let daemon: Daemon | undefined;
let client: DaemonClient | undefined;

function options(extra: Partial<ProjectRunsOptions> = {}): ProjectRunsOptions {
  return { effects: (input) => scriptedActors({ goal: input.goal, delayMs: DELAY_MS }), ...extra };
}

async function startProject(extra: Partial<ProjectRunsOptions> = {}): Promise<void> {
  runs = new ProjectRuns(root, options(extra));
  daemon = await startDaemon({ root, hostFor: (runId) => runs?.hostFor(runId), runs: () => runs?.runs() ?? [] });
  client = await connect(root);
}

async function watch(runId: string): Promise<Watcher> {
  const watcher = new Watcher();
  await requireClient().subscribe(runId, (view) => watcher.push(view as View));
  return watcher;
}

function requireClient(): DaemonClient {
  if (client === undefined) throw new Error('no client');
  return client;
}

function requireRuns(): ProjectRuns {
  if (runs === undefined) throw new Error('no runs');
  return runs;
}

async function send(runId: string, event: Record<string, unknown>): Promise<void> {
  const response = await requireClient().request({ id: newRequestId(), type: 'send', runId, event });
  if (!response.ok) throw new Error(`the daemon refused ${String(event.type)}: ${response.error}`);
}

/** The person's side of a run up to building: approve the spec and the plan as they appear. */
async function approveToBuilding(runId: string, watcher: Watcher): Promise<void> {
  await watcher.stage('specReview');
  await send(runId, { type: 'SPEC_APPROVED' });
  await watcher.stage('planReview');
  await send(runId, { type: 'PLAN_APPROVED' });
  await watcher.stage('building');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-e2e-'));
  fs.writeFileSync(path.join(root, 'bdc.yaml'), 'agents: {}\n');
  scriptedLaunches.reset();
  scriptedSends.length = 0;
  scriptedCloses.length = 0;
});

afterEach(async () => {
  client?.close();
  client = undefined;
  await daemon?.stopDaemon();
  daemon = undefined;
  runs?.stop();
  runs = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a scripted run, end to end', () => {
  it(
    'goes from a goal to a pull request through the daemon and the socket',
    { timeout: 10_000 },
    async () => {
      await startProject();
      const runId = requireRuns().create(GOAL, CONFIG);
      expect(runId).toMatch(/^r-/);
      const watcher = await watch(runId);

      // A person in intake: skip the rest of the questions, confirm the shared understanding.
      await watcher.stage('intake');
      await send(runId, { type: 'SKIP_QUESTIONS' });
      await send(runId, { type: 'UNDERSTANDING_CONFIRMED' });

      await approveToBuilding(runId, watcher);
      await watcher.stage('shipping');
      await send(runId, { type: 'OPEN_PR', draft: true });
      const done = await watcher.stage('done');

      expect(done.error).toBeNull();
      expect(done.needsYou).toBe(false);
      expect(done.pullRequest).toEqual({ path: '.herd/pull-request.md' });
      const phases = done.phases as Array<{ state: string; words: string }>;
      expect(phases.map((phase) => phase.state)).toEqual(['done', 'done']);
      expect(phases.map((phase) => phase.words)).toEqual(['done', 'done']);

      // The pull request file exists, under the project root, and says what was built.
      const prFile = path.join(root, '.herd', 'pull-request.md');
      expect(fs.existsSync(prFile)).toBe(true);
      const pr = fs.readFileSync(prFile, 'utf8');
      expect(pr).toContain(GOAL);
      expect(pr).toContain('p1: First phase');

      // The view on disk is the one the socket streamed, and the snapshot is the run's own state.
      const files = projectPaths(root).run(runId);
      expect(JSON.parse(fs.readFileSync(files.view, 'utf8')).stage).toBe('done');
      expect(fs.existsSync(files.machine)).toBe(true);
      expect(fs.existsSync(path.join(files.dir, 'input.json'))).toBe(true);

      // Every job was launched exactly once: no agent was started twice.
      for (const [key, record] of scriptedLaunches.byKey) {
        expect(record.launches, key).toBe(1);
        expect(record.reattached, key).toBe(0);
      }
      // The agents that were only needed once closed their terminals (§5.5).
      expect(scriptedCloses).toContain(`scripted-${runId}/spec/1`);
      expect(scriptedCloses).toContain(`scripted-${runId}/plan/1`);
      // The person's messages reached the PM as turns, and its answers reached the run's chat.
      expect(scriptedSends.some((sent) => sent.text?.includes('The person says'))).toBe(true);
      const chat = done.chat as Array<{ from: string; text: string }>;
      expect(chat.filter((entry) => entry.from === 'pm').length).toBeGreaterThanOrEqual(1);
    },
  );

  it(
    'continues a run after the daemon restarts in the middle of building',
    { timeout: 10_000 },
    async () => {
      await startProject();
      const runId = requireRuns().create(GOAL, CONFIG);
      const watcher = await watch(runId);
      await approveToBuilding(runId, watcher);

      // The daemon dies (a crash, a Mac restart) while the phases are building.
      client?.close();
      client = undefined;
      await daemon?.stopDaemon();
      daemon = undefined;
      runs?.stop();
      runs = undefined;
      expect(fs.existsSync(path.join(root, '.herd', 'runs', runId, 'machine.json'))).toBe(true);

      // A new daemon on the same project restores the run and carries on.
      await startProject();
      expect(requireRuns().restoreAll()).toEqual([runId]);
      const again = await watch(runId);
      await again.stage('shipping');
      await send(runId, { type: 'OPEN_PR', draft: true });
      const done = await again.stage('done');

      expect(done.error).toBeNull();
      expect(done.stage).toBe('done');
      expect(fs.existsSync(path.join(root, '.herd', 'pull-request.md'))).toBe(true);
      // A restore re-runs invocations; an agent that was already launched is re-attached, never
      // started a second time (§3.2, §5.7).
      for (const [key, record] of scriptedLaunches.byKey) {
        expect(record.launches - record.reattached, key).toBeLessThanOrEqual(1);
      }
    },
  );

  it(
    'lets the PM decide when a review blocks, and the PM continues the run',
    { timeout: 10_000 },
    async () => {
      // A lens prompt with BLOCK makes the scripted reviewer report a high finding (§8).
      await startProject({ lensPrompts: { security: 'BLOCK: report a high finding' } });
      const runId = requireRuns().create(GOAL, CONFIG);
      const watcher = await watch(runId);
      await approveToBuilding(runId, watcher);
      await watcher.stage('shipping');
      await send(runId, { type: 'OPEN_PR', draft: true });
      const done = await watcher.stage('done');

      // The only way out of a blocked review is the PM's decision (§4.5, §6): the run could not
      // have reached the pull request without it.
      expect(done.stage).toBe('done');
      expect(done.error).toBeNull();
      const decisions = scriptedSends.filter((sent) => sent.text?.includes('Call `decide`'));
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions.some((sent) => sent.text?.includes('run'))).toBe(true);
    },
  );
});
