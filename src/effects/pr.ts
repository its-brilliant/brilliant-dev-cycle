/**
 * The pull request (spec §4.4.1, §4.6): the body built from the evidence of a run, and the same
 * run opened on every target the project asks for — a file in the checkout, or a GitHub PR.
 *
 * The body is written from `view.json` (§7.2), the flat projection, plus `input.json` for the goal
 * and the base branch: bdc ships what it can show, not what a model says about it. Words come from
 * the view, so the body says "in review", never a state id (§9.1 rule 4).
 *
 * §4.4.1 wants the proof images attached to a comment on the PR. GitHub has no supported API to
 * upload an attachment to a comment, so bdc pushes the proof files to an orphan branch
 * `bdc/proof/<runId>` and links them with `?raw=true`: the image renders in the comment for
 * anyone who can see the repo. That branch holds proof files and nothing else.
 *
 * Every `git` and `gh` call goes through `run`, so a test can see the exact calls and the suite
 * never reaches GitHub.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fromPromise } from 'xstate';
import type { PromiseActorLogic } from 'xstate';
import { z } from 'zod';
import { RunView, type FindingView, type PhaseView } from '../contracts/view.js';
import type { OpenPullRequestInput, OpenPullRequestOutput } from '../machines/run.js';
import { gitCall, gitText, outputTail, refBranch, runProcess, type GitContext, type RunCommand } from './git.js';

// ── the body ──────────────────────────────────────────────────────────────────────────────

/** The proof kinds that are a picture or a video: the ones §4.4.1 shows as an attachment. */
const MEDIA_KINDS: string[] = ['screenshot', 'recording'];

export interface PullRequestBodyOptions {
  /** The branch the pull request merges into (`config.base`). */
  base: string;
  /** The branch bdc built the run on. */
  runBranch: string;
  draft: boolean;
  /**
   * How the body points at a proof file: a path relative to the body for the file target, a URL on
   * GitHub, or null when bdc has nothing to point at. GitHub proof goes in the phase comments, so
   * the PR body lists the items without links.
   */
  proofHref?: (file: string) => string | null;
}

/** The title of the pull request: the goal the person gave, in their own words (§4.6). */
export function pullRequestTitle(view: RunView): string {
  const goal = (view.goal.split('\n')[0] ?? '').trim();
  return goal === '' ? `bdc run ${view.runId}` : goal;
}

function findingStatusWords(status: FindingView['status']): string {
  switch (status) {
    case 'open':
      return 'open';
    case 'fixing':
      return 'being fixed';
    case 'fixed':
      return 'fixed';
    case 'continued':
      return 'continued by the PM';
    case 'overridden':
      return 'overridden by you';
    case 'advisory':
      return 'advisory, below the level that blocks';
  }
}

function proofByWords(by: 'bdc' | 'verifier' | 'person'): string {
  switch (by) {
    case 'bdc':
      return 'from bdc itself';
    case 'verifier':
      return 'from the verifier';
    case 'person':
      return 'from you';
  }
}

function stepLine(step: { command: string; exitCode: number | null }): string {
  const outcome =
    step.exitCode === null ? 'did not finish' : step.exitCode === 0 ? 'passed' : `failed (exit ${step.exitCode})`;
  return `- \`${step.command}\` — ${outcome}`;
}

function findingLine(finding: FindingView): string {
  const where =
    finding.file === undefined ? '' : ` (${finding.file}${finding.line === undefined ? '' : `:${finding.line}`})`;
  return `- **${finding.severity}** ${finding.summary} — ${findingStatusWords(finding.status)}${where}`;
}

function phaseSection(phase: PhaseView): string[] {
  const lines = [`### ${phase.title}`, '', `Status: ${phase.words}.`, ''];
  if (phase.verification === null) {
    lines.push('No checks were recorded for this phase.', '');
  } else {
    lines.push(phase.verification.passed ? 'The checks passed:' : 'The checks did not pass:', '');
    lines.push(...phase.verification.steps.map(stepLine), '');
  }
  if (phase.findings.length > 0) {
    lines.push('Findings:', '', ...phase.findings.map(findingLine), '');
  }
  if (phase.proof.length > 0) {
    lines.push(
      'Proof:',
      '',
      ...phase.proof.map((item) => `- ${item.kind}${item.shows.trim() === '' ? '' : `: ${item.shows}`} (${proofByWords(item.by)})`),
      '',
    );
  }
  return lines;
}

function proofSection(phase: PhaseView, href: (file: string) => string | null): string[] {
  const lines = [`### ${phase.title}`, ''];
  for (const item of phase.proof) {
    const link = item.file === undefined ? null : href(item.file);
    const where = link === null ? '' : ` — [${path.basename(item.file ?? '')}](${link})`;
    const shows = item.shows.trim() === '' ? '' : `: ${item.shows}`;
    lines.push(`- ${item.kind}${shows} (${proofByWords(item.by)})${where}`);
  }
  lines.push('');
  return lines;
}

/** Every finding the run did not settle by fixing: the PM continued it or the person overrode it (§4.6). */
function overrides(view: RunView): Array<{ finding: FindingView; where: string }> {
  const settled = (finding: FindingView): boolean => finding.status === 'continued' || finding.status === 'overridden';
  return [
    ...view.phases.flatMap((phase) => phase.findings.filter(settled).map((finding) => ({ finding, where: phase.title }))),
    ...view.finalFindings.filter(settled).map((finding) => ({ finding, where: 'the whole run' })),
  ];
}

/**
 * The pull request body, from the view and nothing else: what was asked for, the spec it was built
 * against, what each phase did and proved, the review of the whole run, and what went on anyway.
 */
export function pullRequestBody(view: RunView, options: PullRequestBodyOptions): string {
  const href = options.proofHref ?? ((): string | null => null);
  const lines: string[] = [
    `# ${pullRequestTitle(view)}`,
    '',
    `Run \`${view.runId}\`: \`${options.runBranch}\` → \`${options.base}\`${options.draft ? ', as a draft' : ''}.`,
    '',
    '## Summary',
    '',
  ];

  if (view.brief === null) {
    lines.push('bdc has no brief for this run.', '');
  } else {
    lines.push(view.brief.brief, '');
    if (view.brief.decisions.length > 0) {
      lines.push('Decisions you made:', '', ...view.brief.decisions.map((d) => `- ${d.question} → ${d.answer}`), '');
    }
    if (view.brief.assumptions.length > 0) {
      lines.push('Assumptions:', '', ...view.brief.assumptions.map((a) => `- ${a}`), '');
    }
  }

  lines.push('## Spec', '');
  if (view.spec === null) {
    lines.push('bdc has no spec for this run.', '');
  } else {
    const file = `.herd/runs/${view.runId}/spec.v${view.spec.version}.md`;
    lines.push(`The spec this run was built against: [\`${file}\`](${file}), version ${view.spec.version}.`, '');
  }

  lines.push('## Phases', '');
  if (view.phases.length === 0) {
    lines.push('bdc ran no phases for this run.', '');
  } else {
    for (const phase of view.phases) lines.push(...phaseSection(phase));
  }

  lines.push('## Review', '');
  if (view.finalFindings.length === 0) {
    lines.push('The review of the whole run found nothing to report.', '');
  } else {
    lines.push(...view.finalFindings.map(findingLine), '');
  }

  lines.push('## Overrides', '');
  const continued = overrides(view);
  if (continued.length === 0) {
    lines.push('Nothing was continued or overridden.', '');
  } else {
    for (const { finding, where } of continued) {
      const reason = finding.note.trim() === '' ? 'no reason recorded' : finding.note;
      lines.push(
        `- ${finding.id} (${finding.severity}, ${where}): ${finding.summary} — ${findingStatusWords(finding.status)}; ${reason}`,
      );
    }
    lines.push('');
  }

  lines.push('## Proof', '');
  const proved = view.phases.filter((phase) => phase.proof.length > 0);
  if (proved.length === 0) {
    lines.push('bdc has no proof items for this run.', '');
  } else {
    for (const phase of proved) lines.push(...proofSection(phase, href));
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

// ── what the run left on disk ─────────────────────────────────────────────────────────────

/** `input.json` beside the snapshot: the goal, and the base branch a PR merges into (§5.7, §10). */
const RunInputFile = z.object({ goal: z.string(), config: z.object({ base: z.string() }) });

interface RunData {
  view: RunView;
  base: string;
}

function readRun(root: string, runId: string): RunData {
  const dir = path.join(root, '.herd', 'runs', runId);
  const viewFile = path.join(dir, 'view.json');
  const inputFile = path.join(dir, 'input.json');

  let view: RunView;
  try {
    view = RunView.parse(JSON.parse(fs.readFileSync(viewFile, 'utf8')));
  } catch (error) {
    throw new Error(`bdc cannot read the run's view (${viewFile}): ${error instanceof Error ? error.message : String(error)}`);
  }

  let input: z.infer<typeof RunInputFile>;
  try {
    input = RunInputFile.parse(JSON.parse(fs.readFileSync(inputFile, 'utf8')));
  } catch (error) {
    throw new Error(`bdc cannot read the run's input (${inputFile}): ${error instanceof Error ? error.message : String(error)}`);
  }

  // The goal the person typed is in input.json; the projection copies it, and bdc ships the person's
  // own words even if the two ever drift.
  return { view: { ...view, goal: input.goal }, base: input.config.base };
}

/**
 * Where a proof item's `file` is on disk. Whoever made the item wrote the path it saw: the verifier
 * works in the phase worktree, bdc in the run worktree, and a person may hand over an absolute one.
 * The first path that exists wins.
 */
function resolveProofFile(root: string, runId: string, phaseId: string, file: string): string | null {
  const candidates = path.isAbsolute(file)
    ? [file]
    : [
        path.join(root, file),
        path.join(root, '.worktrees', `bdc-${runId}`, file),
        path.join(root, '.worktrees', `bdc-${runId}-${phaseId}`, file),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** The proof files of the whole run, with the path each one was found at (null: bdc could not find it). */
function proofFiles(root: string, view: RunView): Array<{ phase: PhaseView; item: PhaseView['proof'][number]; found: string | null }> {
  return view.phases.flatMap((phase) =>
    phase.proof.map((item) => ({
      phase,
      item,
      found: item.file === undefined ? null : resolveProofFile(root, view.runId, phase.id, item.file),
    })),
  );
}

// ── the file target ──────────────────────────────────────────────────────────────────────

/**
 * Writes the body into the checkout and the list of proof files next to it (§4.4.1: the proof stays
 * under `.herd/runs/<run>/phases/<phase>/proof/` and the body links it relatively).
 */
function writeFileTarget(input: OpenPullRequestInput, run: RunData, relative: string): string {
  const file = path.resolve(input.root, relative);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const files = proofFiles(input.root, run.view);
  const body = pullRequestBody(run.view, {
    base: run.base,
    runBranch: input.runBranch,
    // A file is neither a draft nor ready: that choice belongs to the pull request itself.
    draft: false,
    proofHref: (proof) => {
      const found = files.find((candidate) => candidate.item.file === proof)?.found;
      return found == null ? null : path.relative(dir, found);
    },
  });
  fs.writeFileSync(file, body);

  const listFile = file.replace(/\.md$/i, '') + '.proof.json';
  const list = files.map(({ phase, item, found }) => ({
    phase: phase.title,
    kind: item.kind,
    shows: item.shows,
    by: item.by,
    file: item.file ?? null,
    path: found,
  }));
  fs.writeFileSync(listFile, `${JSON.stringify({ runId: run.view.runId, proof: list }, null, 2)}\n`);
  return relative;
}

// ── the GitHub target ────────────────────────────────────────────────────────────────────

interface GithubTarget {
  provider: 'github';
  repo?: string;
  draft: boolean;
}

interface PrContext extends GitContext {
  ghBin: string;
}

/** One gh call that has to succeed. A missing gh is a message a person can act on, not a stack. */
async function ghText(ctx: PrContext, root: string, args: string[]): Promise<string> {
  const result = await ctx.run(ctx.ghBin, args, { cwd: root });
  if (result.error !== undefined) {
    throw new Error(`gh is not installed or not runnable (${ctx.ghBin}): ${result.error.message}`);
  }
  if (result.code !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (exit ${result.code}): ${outputTail(result.stderr)}`);
  }
  return result.stdout;
}

/** `owner/name` from a GitHub remote URL (`git@github.com:owner/name.git` and the https forms). */
export function githubRepoFrom(url: string): string | null {
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** The repository gh and the proof links name: the target's, else the origin remote's. */
async function githubRepo(ctx: PrContext, root: string, target: GithubTarget): Promise<string | null> {
  if (target.repo !== undefined) return target.repo;
  const remote = await gitCall(ctx, root, ['remote', 'get-url', 'origin']);
  return remote.code === 0 ? githubRepoFrom(remote.stdout) : null;
}

/** A file gh can read for one call, removed afterwards. */
function withTempFile<T>(name: string, text: string, use: (file: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-pr-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return use(file).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** The PR already open for this head branch, if there is one: a second ship reuses it, never duplicates it. */
async function existingPullRequest(ctx: PrContext, root: string, runBranch: string): Promise<string | null> {
  const result = await ctx.run(ctx.ghBin, ['pr', 'view', runBranch, '--json', 'url'], { cwd: root });
  if (result.code !== 0) return null;
  try {
    const url = (JSON.parse(result.stdout) as { url?: unknown }).url;
    return typeof url === 'string' && url !== '' ? url : null;
  } catch {
    return null;
  }
}

/** The tip of the proof branch bdc pushed before, so a second ship fast-forwards instead of failing. */
async function proofBranchTip(ctx: PrContext, root: string, branch: string): Promise<string | null> {
  const local = await gitCall(ctx, root, ['rev-parse', '--quiet', '--verify', `refs/heads/${branch}`]);
  if (local.code === 0) return local.stdout.trim();
  const fetched = await gitCall(ctx, root, ['fetch', 'origin', `refs/heads/${branch}`]);
  if (fetched.code !== 0) return null;
  const tip = await gitCall(ctx, root, ['rev-parse', '--quiet', '--verify', 'FETCH_HEAD']);
  return tip.code === 0 ? tip.stdout.trim() : null;
}

/**
 * Pushes the media proof of every phase to the orphan branch `bdc/proof/<runId>`, and answers the
 * URL of each file on it. The branch holds only the proof files: bdc builds the tree in a temporary
 * index, so no worktree is added and the root checkout is never touched.
 */
async function publishProof(
  ctx: PrContext,
  input: OpenPullRequestInput,
  run: RunData,
  repo: string,
): Promise<Map<string, string>> {
  const media = proofFiles(input.root, run.view).filter(
    (entry) => entry.item.file !== undefined && entry.found !== null && MEDIA_KINDS.includes(entry.item.kind),
  );
  const published = new Map<string, string>();
  if (media.length === 0) return published;

  const branch = `bdc/proof/${input.runId}`;
  const index = path.join(os.tmpdir(), `bdc-proof-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const placed = media.map((entry) => ({
      file: entry.item.file as string,
      // One directory per phase, so two phases cannot overwrite each other's `screenshot.png`.
      dest: `${entry.phase.id}/${path.basename(entry.found as string)}`,
      found: entry.found as string,
    }));
    for (const { dest, found } of placed) {
      const blob = (await gitText(ctx, input.root, ['hash-object', '-w', found])).trim();
      await gitText(ctx, input.root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${dest}`], {
        GIT_INDEX_FILE: index,
      });
    }
    const tree = (await gitText(ctx, input.root, ['write-tree'], { GIT_INDEX_FILE: index })).trim();
    const parent = await proofBranchTip(ctx, input.root, branch);
    const commitArgs = ['commit-tree', tree, '-m', `bdc: proof for ${input.runId}`];
    if (parent !== null) commitArgs.push('-p', parent);
    const commit = (await gitText(ctx, input.root, commitArgs)).trim();
    await gitText(ctx, input.root, ['update-ref', `refs/heads/${branch}`, commit]);
    await gitText(ctx, input.root, ['push', 'origin', branch]);
    for (const { file, dest } of placed) {
      published.set(file, `https://github.com/${repo}/blob/${branch}/${dest}?raw=true`);
    }
  } finally {
    fs.rmSync(index, { force: true });
  }
  return published;
}

/** One comment per phase that has a picture or a recording: what each item shows, and the item (§4.4.1). */
function commentBody(phase: PhaseView, published: Map<string, string>): string {
  const lines = [`## Proof: ${phase.title}`, ''];
  for (const item of phase.proof) {
    if (!MEDIA_KINDS.includes(item.kind)) continue;
    const link = item.file === undefined ? undefined : published.get(item.file);
    const shows = item.shows.trim() === '' ? `A ${item.kind} of this phase` : item.shows;
    if (link !== undefined) {
      lines.push(`**${shows}**`, '', `![${item.kind}](${link})`, '', `[${item.kind}](${link})`, '');
    } else {
      lines.push(`**${shows}**`, '', `bdc could not attach this ${item.kind}.`, '');
    }
  }
  lines.push('Added by bdc.');
  return `${lines.join('\n')}\n`;
}

async function openGithubTarget(ctx: PrContext, input: OpenPullRequestInput, run: RunData, target: GithubTarget): Promise<string> {
  const branch = refBranch(input.runBranch);
  // The run branch first: a pull request needs it on the remote. Never forced: a push that is not a
  // fast-forward is somebody else's work, and bdc says so instead of overwriting it.
  await gitText(ctx, input.root, ['push', '-u', 'origin', branch]);

  const repo = await githubRepo(ctx, input.root, target);
  const hasMedia = run.view.phases.some((phase) => phase.proof.some((item) => MEDIA_KINDS.includes(item.kind)));
  if (hasMedia && repo === null) {
    throw new Error(
      'bdc cannot link the proof of this run: name the GitHub repository in the pull request target (repo: owner/name), or give the checkout an origin remote',
    );
  }

  const existing = await existingPullRequest(ctx, input.root, branch);
  let url = existing;
  if (url === null) {
    const body = pullRequestBody(run.view, {
      base: run.base,
      runBranch: input.runBranch,
      draft: input.draft,
      // The body names the proof items; the pictures are in the phase comments below.
    });
    const args = ['pr', 'create', '--base', run.base, '--head', branch, '--title', pullRequestTitle(run.view)];
    url = await withTempFile('body.md', body, async (file) => {
      const full = [...args, '--body-file', file];
      // The person's choice on the Ship screen (§4.6) decides draft or ready; the target's `draft`
      // is the default that screen starts from.
      if (input.draft) full.push('--draft');
      if (repo !== null) full.push('--repo', repo);
      return pullUrl(await ghText(ctx, input.root, full));
    });
  }

  const published = repo === null ? new Map<string, string>() : await publishProof(ctx, input, run, repo);

  for (const phase of run.view.phases) {
    if (!phase.proof.some((item) => MEDIA_KINDS.includes(item.kind))) continue;
    const body = commentBody(phase, published);
    await withTempFile(`comment-${phase.id}.md`, body, async (file) => {
      await ghText(ctx, input.root, ['pr', 'comment', url, '--body-file', file]);
    });
  }
  return url;
}

/** The URL gh printed when it created the pull request: the last line that looks like one. */
function pullUrl(stdout: string): string {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('https://'));
  const url = lines[lines.length - 1];
  if (url === undefined) throw new Error(`gh did not print the pull request's URL: ${outputTail(stdout)}`);
  return url;
}

// ── the effect ───────────────────────────────────────────────────────────────────────────

export interface PrEffectOptions {
  /** The command runner. Tests pass a fake, so nothing here reaches GitHub. */
  run?: RunCommand;
  ghBin?: string;
  gitBin?: string;
}

export interface PrEffects {
  openPullRequest: PromiseActorLogic<OpenPullRequestOutput, OpenPullRequestInput>;
}

async function openPullRequest(ctx: PrContext, input: OpenPullRequestInput): Promise<OpenPullRequestOutput> {
  const run = readRun(input.root, input.runId);
  const output: OpenPullRequestOutput = {};
  for (const target of input.prTargets) {
    if (target.provider === 'file') output.path = writeFileTarget(input, run, target.path);
    else output.url = await openGithubTarget(ctx, input, run, target);
  }
  if (output.url === undefined && output.path === undefined) {
    throw new Error('this project has no pull request target: add one to pr_targets in bdc.yaml');
  }
  return output;
}

/** `openPullRequest` (§4.6): the body, and the same run opened on every target. */
export function prEffect(options: PrEffectOptions = {}): PrEffects {
  const ctx: PrContext = {
    ghBin: options.ghBin ?? 'gh',
    gitBin: options.gitBin ?? 'git',
    run: options.run ?? runProcess,
  };
  return {
    openPullRequest: fromPromise<OpenPullRequestOutput, OpenPullRequestInput>(({ input }) => openPullRequest(ctx, input)),
  };
}
