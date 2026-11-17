/**
 * The three slice-5 screens' plain parts (spec §4.2, §4.3, §3.1): the spec's blocks and comment
 * anchors, the plan's DAG geometry, and the setup form's choices and config.
 *
 * Each helper is a plain JavaScript module beside its screen, because a mod is JavaScript Herdr
 * loads as-is and the screens themselves import gpui-kit and Herdr. They are loaded here by path
 * (the dynamic import is deliberate: there is no `.d.ts` beside a screen helper, and the test says
 * what shape it expects in the interfaces below), and everything the screens draw is built from
 * these answers.
 */
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCREENS = fileURLToPath(new URL('../../herdr-app/mods/bdc-main/screens/', import.meta.url));

async function helper<T>(file: string): Promise<T> {
  return (await import(pathToFileURL(join(SCREENS, file)).href)) as T;
}

// ── what the helper modules answer ──────────────────────────────────────────────────────────

interface Block {
  kind: string;
  level?: number;
  text: string;
  index: number;
  id: string;
}
interface Segment {
  text: string;
  commentId: string | null;
}
interface Anchor {
  quote: string;
  prefix: string;
  suffix: string;
}
interface Comment {
  id: string;
  quote: string;
  prefix?: string;
  suffix?: string;
  body: string;
  replyTo?: string;
  resolved?: boolean;
}
interface Thread {
  comment: Comment;
  replies: Comment[];
}
interface SpecBlocks {
  AROUND: number;
  splitBlocks(markdown: string): Block[];
  quoteAnchor(text: string, start: number, end: number): Anchor;
  highlightSegments(text: string, comments: Comment[]): Segment[];
  commentThreads(comments: Comment[]): Thread[];
  openCount(comments: Comment[]): number;
  nextCommentId(comments: Comment[]): string;
}

interface Phase {
  id: string;
  title: string;
  deps: string[];
  tasks: Array<{ id: string; title: string; paths: string[] }>;
  checks: Array<{ run?: string; agent?: string }>;
  proof: Array<{ kind: string; shows: string }>;
}
interface Card {
  id: string;
  phase: Phase;
  depth: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface Edge {
  from: string;
  to: string;
  segments: Rect[];
}
interface Layout {
  width: number;
  height: number;
  cards: Card[];
  edges: Edge[];
  cyclic: string[];
  depthOf: Record<string, number>;
}
interface PlanDag {
  CARD: { width: number; height: number };
  SPACING: { pad: number; gapX: number; gapY: number };
  dagDepths(phases: Phase[]): { depth: Map<string, number>; cyclic: string[] };
  dagLayout(phases: Phase[], options?: { card?: { width: number; height: number } }): Layout;
  dependants(phases: Phase[], id: string): string[];
  checkWords(check: { run?: string; agent?: string }): string;
  proofKinds(phase: Phase): string[];
  countWords(count: number, one: string, many?: string): string;
}

interface Choice {
  key: string;
  name: string;
  installed: boolean;
  supported: boolean;
}
interface RoleChoice {
  cli: string;
  model: string;
}
type Roles = Record<string, RoleChoice>;
interface Form {
  roles: Roles;
  lenses: string[];
  checks: string[];
  noVerification: boolean;
}
interface SetupForm {
  ROLE_FIELDS: Array<{ role: string; label: string; hint: string }>;
  ROLES: string[];
  SUPPORTED: string[];
  DEFAULT_LENS: string;
  cliChoices(known: unknown): Choice[];
  choiceReason(choice: Choice): string;
  pickableClis(choices: Choice[]): string[];
  roleDefaults(installed: string[]): Roles;
  rolesWithChoices(roles: Roles | undefined, pickable: string[], fallback: string): Roles;
  addLens(name: string, lenses: string[]): { ok: boolean; lenses: string[]; error: string };
  removeLens(name: string, lenses: string[]): string[];
  formProblem(form: Form): string;
  configFromForm(form: Form): {
    agents: Roles;
    lenses: Record<string, { block_on: string }>;
    verification: { checks: Array<{ run: string }> } | null;
  };
  initArgs(root: string, configJson: string, options?: { force?: boolean }): string[];
}

// ── the spec ───────────────────────────────────────────────────────────────────────────────

const SPEC_MARKDOWN = [
  '# brilliant-dev-cycle',
  '',
  'A standalone repo that ships a layout',
  'and a small CLI.',
  '',
  '## Goals',
  '',
  '- The spec is agreed through comments',
  '- Phases form a DAG',
  '',
  '```sh',
  'npm test',
  '```',
  '',
  '| check | command |',
  '| --- | --- |',
  '| unit | npm test |',
].join('\n');

describe('splitting the spec into blocks', () => {
  it('makes one block per heading, paragraph, list item, code block and table', async () => {
    const { splitBlocks } = await helper<SpecBlocks>('spec-blocks.js');

    const blocks = splitBlocks(SPEC_MARKDOWN);

    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'heading', 'item', 'item', 'code', 'table']);
    expect(blocks.map((block) => block.id)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
    expect(blocks.map((block) => block.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('keeps a paragraph’s lines together and a heading’s level', async () => {
    const { splitBlocks } = await helper<SpecBlocks>('spec-blocks.js');

    const blocks = splitBlocks(SPEC_MARKDOWN);

    expect(blocks[0]?.text).toBe('# brilliant-dev-cycle');
    expect(blocks[0]?.level).toBe(1);
    expect(blocks[1]?.text).toBe('A standalone repo that ships a layout\nand a small CLI.');
    expect(blocks[2]?.level).toBe(2);
  });

  it('keeps a code block whole, fences and all, so it still renders as code', async () => {
    const { splitBlocks } = await helper<SpecBlocks>('spec-blocks.js');

    const code = splitBlocks(SPEC_MARKDOWN).find((block) => block.kind === 'code');

    expect(code?.text).toBe('```sh\nnpm test\n```');
  });

  it('answers no blocks for an empty spec, and skips blank lines', async () => {
    const { splitBlocks } = await helper<SpecBlocks>('spec-blocks.js');

    expect(splitBlocks('')).toEqual([]);
    expect(splitBlocks('\n\n  \n')).toEqual([]);
    expect(splitBlocks('one\n\n\n\ntwo').map((block) => block.text)).toEqual(['one', 'two']);
  });

  it('does not mistake a dash in a sentence for a list item', async () => {
    const { splitBlocks } = await helper<SpecBlocks>('spec-blocks.js');

    const blocks = splitBlocks('A phase - with a dash - stays one paragraph.');

    expect(blocks.map((block) => block.kind)).toEqual(['paragraph']);
  });
});

describe('anchoring a comment to the words it quotes', () => {
  it('quotes the selection and keeps the text around it', async () => {
    const { quoteAnchor } = await helper<SpecBlocks>('spec-blocks.js');

    expect(quoteAnchor('the quick brown fox', 10, 15)).toEqual({ quote: 'brown', prefix: 'the quick ', suffix: ' fox' });
  });

  it('means the whole block when nothing is selected', async () => {
    const { quoteAnchor } = await helper<SpecBlocks>('spec-blocks.js');

    expect(quoteAnchor('- the quick brown fox', 6, 6)).toEqual({ quote: '- the quick brown fox', prefix: '', suffix: '' });
  });

  it('drops the spaces at the ends of a selection, and reads a backwards one', async () => {
    const { quoteAnchor } = await helper<SpecBlocks>('spec-blocks.js');

    expect(quoteAnchor('the quick brown fox', 9, 16).quote).toBe('brown');
    expect(quoteAnchor('the quick brown fox', 15, 10).quote).toBe('brown');
  });

  it('clamps offsets outside the block instead of quoting nothing', async () => {
    const { quoteAnchor } = await helper<SpecBlocks>('spec-blocks.js');

    expect(quoteAnchor('short', -5, 99).quote).toBe('short');
    expect(quoteAnchor('short', Number.NaN, Number.NaN).quote).toBe('short');
  });

  it('keeps at most 40 characters on each side', async () => {
    const { quoteAnchor, AROUND } = await helper<SpecBlocks>('spec-blocks.js');
    const text = `${'a'.repeat(200)}QUOTE${'b'.repeat(200)}`;
    const at = text.indexOf('QUOTE');

    const anchor = quoteAnchor(text, at, at + 'QUOTE'.length);

    expect(AROUND).toBe(40);
    expect(anchor.quote).toBe('QUOTE');
    expect(anchor.prefix.length).toBe(40);
    expect(anchor.suffix.length).toBe(40);
    expect(anchor.prefix).toBe('a'.repeat(40));
    expect(anchor.suffix).toBe('b'.repeat(40));
  });
});

describe('highlighting the quotes in a block', () => {
  it('splits the block around a quoted phrase, so the quote can get a background', async () => {
    const { highlightSegments } = await helper<SpecBlocks>('spec-blocks.js');

    const segments = highlightSegments('the quick brown fox', [{ id: 'c1', quote: 'brown', body: 'too fast' }]);

    expect(segments).toEqual([
      { text: 'the quick ', commentId: null },
      { text: 'brown', commentId: 'c1' },
      { text: ' fox', commentId: null },
    ]);
  });

  it('leaves a block whole when no comment quotes it, and when a quote is the whole block', async () => {
    const { highlightSegments } = await helper<SpecBlocks>('spec-blocks.js');

    expect(highlightSegments('the quick brown fox', [])).toEqual([{ text: 'the quick brown fox', commentId: null }]);
    expect(highlightSegments('the quick brown fox', [{ id: 'c1', quote: 'not in here', body: 'x' }])).toEqual([
      { text: 'the quick brown fox', commentId: null },
    ]);
    expect(highlightSegments('the quick brown fox', [{ id: 'c1', quote: 'the quick brown fox', body: 'x' }])).toEqual([
      { text: 'the quick brown fox', commentId: null },
    ]);
  });

  it('splits around several quotes, in the order they appear', async () => {
    const { highlightSegments } = await helper<SpecBlocks>('spec-blocks.js');

    const segments = highlightSegments('one two three', [
      { id: 'c1', quote: 'two', body: 'x' },
      { id: 'c2', quote: 'three', body: 'y' },
    ]);

    expect(segments).toEqual([
      { text: 'one ', commentId: null },
      { text: 'two', commentId: 'c1' },
      { text: ' ', commentId: null },
      { text: 'three', commentId: 'c2' },
    ]);
  });

  it('never shows two quotes over the same words', async () => {
    const { highlightSegments } = await helper<SpecBlocks>('spec-blocks.js');

    const segments = highlightSegments('ababab', [
      { id: 'c1', quote: 'ab', body: 'x' },
      { id: 'c2', quote: 'ba', body: 'y' },
    ]);

    expect(segments).toEqual([
      { text: 'ab', commentId: 'c1' },
      { text: 'abab', commentId: null },
    ]);
  });

  it('picks the occurrence the quote’s prefix and suffix agree with', async () => {
    const { highlightSegments } = await helper<SpecBlocks>('spec-blocks.js');

    const segments = highlightSegments('foo bar foo baz', [{ id: 'c1', quote: 'foo', prefix: 'bar ', suffix: ' baz', body: 'x' }]);

    expect(segments).toEqual([
      { text: 'foo bar ', commentId: null },
      { text: 'foo', commentId: 'c1' },
      { text: ' baz', commentId: null },
    ]);
  });
});

describe('the comment column', () => {
  const comments: Comment[] = [
    { id: 'c1', quote: 'one', body: 'first' },
    { id: 'c2', quote: 'one', body: 'a reply', replyTo: 'c1' },
    { id: 'c3', quote: 'two', body: 'settled', resolved: true },
    { id: 'c4', quote: 'three', body: 'orphan', replyTo: 'gone' },
  ];

  it('puts replies under their comment, open threads first', async () => {
    const { commentThreads } = await helper<SpecBlocks>('spec-blocks.js');

    const threads = commentThreads(comments);

    expect(threads.map((thread) => thread.comment.id)).toEqual(['c1', 'c4', 'c3']);
    expect(threads[0]?.replies.map((reply) => reply.id)).toEqual(['c2']);
  });

  it('counts the comments still open, which is what Request changes needs', async () => {
    const { openCount } = await helper<SpecBlocks>('spec-blocks.js');

    expect(openCount(comments)).toBe(3);
    expect(openCount([])).toBe(0);
  });

  it('names a new comment something the transcript can point at, without reusing an id', async () => {
    const { nextCommentId } = await helper<SpecBlocks>('spec-blocks.js');

    expect(nextCommentId([])).toBe('c1');
    expect(nextCommentId([{ id: 'c1', quote: 'a', body: 'x' }])).toBe('c2');
    expect(nextCommentId([{ id: 'c1', quote: 'a', body: 'x' }, { id: 'c3', quote: 'b', body: 'y' }])).toBe('c4');
  });
});

// ── the plan ───────────────────────────────────────────────────────────────────────────────

function phase(id: string, deps: string[] = [], proof: string[] = ['tests']): Phase {
  return {
    id,
    title: `${id} title`,
    deps,
    tasks: [{ id: `${id}-t1`, title: 'a task', paths: ['src/a.ts'] }],
    checks: [{ run: 'npm test' }],
    proof: proof.map((kind) => ({ kind, shows: `${kind} proof` })),
  };
}

/** True when a 1px line runs through the middle of a card: an edge must never do that. */
function crossesCard(segment: Rect, card: Card): boolean {
  const middleX = segment.left + segment.width / 2;
  const middleY = segment.top + segment.height / 2;
  return middleX > card.x && middleX < card.x + card.width && middleY > card.y && middleY < card.y + card.height;
}

describe('the phase graph', () => {
  it('gives each phase a column: one more than its deepest dependency', async () => {
    const { dagDepths } = await helper<PlanDag>('plan-dag.js');

    const { depth, cyclic } = dagDepths([phase('p1'), phase('p2', ['p1']), phase('p3', ['p2']), phase('p4', ['p1'])]);

    expect([...depth.entries()]).toEqual([
      ['p1', 0],
      ['p2', 1],
      ['p3', 2],
      ['p4', 1],
    ]);
    expect(cyclic).toEqual([]);
  });

  it('places the cards left to right by column and top to bottom by the planner’s order', async () => {
    const { dagLayout, CARD, SPACING } = await helper<PlanDag>('plan-dag.js');

    const layout = dagLayout([phase('p1'), phase('p2', ['p1']), phase('p3', ['p1'])]);

    const boxes = new Map(layout.cards.map((card) => [card.id, card]));
    expect(boxes.get('p1')?.x).toBe(SPACING.pad);
    expect(boxes.get('p2')?.x).toBe(SPACING.pad + CARD.width + SPACING.gapX);
    expect(boxes.get('p3')?.x).toBe(boxes.get('p2')?.x);
    expect(boxes.get('p3')?.y).toBe((boxes.get('p2')?.y ?? 0) + CARD.height + SPACING.gapY);
    expect(layout.width).toBe(SPACING.pad + 2 * (CARD.width + SPACING.gapX) - SPACING.gapX + SPACING.pad);
    expect(layout.height).toBe(SPACING.pad + 2 * CARD.height + SPACING.gapY + SPACING.pad);
  });

  it('draws one edge per dependency, and never through a card', async () => {
    const { dagLayout } = await helper<PlanDag>('plan-dag.js');
    const phases = [phase('p1'), phase('p2', ['p1']), phase('p3', ['p1']), phase('p4', ['p2', 'p3']), phase('p5', ['p1']), phase('p6', ['p4', 'p5'])];

    const layout = dagLayout(phases);

    expect(layout.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['p1->p2', 'p1->p3', 'p2->p4', 'p3->p4', 'p1->p5', 'p4->p6', 'p5->p6']);
    for (const edge of layout.edges) {
      for (const segment of edge.segments) {
        expect(segment.width).toBeGreaterThanOrEqual(1);
        expect(segment.height).toBeGreaterThanOrEqual(1);
        expect(segment.left).toBeGreaterThanOrEqual(0);
        expect(segment.top).toBeGreaterThanOrEqual(0);
        expect(segment.left + segment.width).toBeLessThanOrEqual(layout.width);
        expect(segment.top + segment.height).toBeLessThanOrEqual(layout.height);
        for (const card of layout.cards) expect(crossesCard(segment, card)).toBe(false);
      }
    }
  });

  it('works for one phase and for twelve, which is as long a plan as the screen has to hold', async () => {
    const { dagLayout, CARD, SPACING } = await helper<PlanDag>('plan-dag.js');

    const one = dagLayout([phase('p1')]);
    expect(one.cards.length).toBe(1);
    expect(one.edges).toEqual([]);
    expect(one.width).toBe(SPACING.pad * 2 + CARD.width);

    const chain = Array.from({ length: 12 }, (_, index) => phase(`p${index + 1}`, index === 0 ? [] : [`p${index}`]));
    const twelve = dagLayout(chain);
    expect(twelve.cards.length).toBe(12);
    expect(twelve.edges.length).toBe(11);
    expect(Math.max(...twelve.cards.map((card) => card.depth))).toBe(11);
    expect(twelve.width).toBe(SPACING.pad * 2 + 12 * CARD.width + 11 * SPACING.gapX);
  });

  it('reports a cycle instead of following it, and still draws the phases', async () => {
    const { dagLayout } = await helper<PlanDag>('plan-dag.js');

    const layout = dagLayout([phase('a', ['b']), phase('b', ['a'])]);

    expect(layout.cyclic.length).toBeGreaterThan(0);
    expect(layout.cards.length).toBe(2);
    // The one edge that can point left to right is drawn; the one that would point back is not.
    for (const edge of layout.edges) expect(layout.depthOf[edge.to]).toBeGreaterThan(layout.depthOf[edge.from] ?? -1);
    expect(layout.edges.length).toBeLessThan(2);
  });

  it('ignores a dependency on a phase that is no longer in the plan', async () => {
    const { dagLayout } = await helper<PlanDag>('plan-dag.js');

    const layout = dagLayout([phase('p1', ['gone']), phase('p2', ['p1', 'gone'])]);

    expect(layout.depthOf['p1']).toBe(0);
    expect(layout.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['p1->p2']);
  });

  it('says what a phase unlocks, what its checks are and what proof it needs', async () => {
    const { dependants, checkWords, proofKinds, countWords } = await helper<PlanDag>('plan-dag.js');
    const phases = [phase('p1'), phase('p2', ['p1']), phase('p3', ['p1'])];

    expect(dependants(phases, 'p1')).toEqual(['p2', 'p3']);
    expect(dependants(phases, 'p2')).toEqual([]);
    expect(checkWords({ run: 'npm test' })).toBe('npm test');
    expect(checkWords({ agent: 'click through it' })).toBe('click through it (an agent)');
    expect(proofKinds(phase('p1', [], ['tests', 'tests', 'screenshot']))).toEqual(['tests', 'screenshot']);
    expect(countWords(1, 'task')).toBe('1 task');
    expect(countWords(3, 'task')).toBe('3 tasks');
  });
});

// ── setup ──────────────────────────────────────────────────────────────────────────────────

describe('who can do each job', () => {
  it('offers the CLIs Herdr knows, and adds a supported one it does not list', async () => {
    const { cliChoices, choiceReason, pickableClis } = await helper<SetupForm>('setup-form.js');

    const choices = cliChoices([
      { key: 'claude', name: 'Claude Code', installed: true },
      { key: 'codex', name: 'Codex', installed: true },
      { key: 'pi', name: 'pi', installed: false },
    ]);

    expect(choices.map((choice) => choice.key)).toEqual(['claude', 'codex', 'pi']);
    expect(pickableClis(choices)).toEqual(['claude']);
    expect(choiceReason(choices[0] as Choice)).toBe('');
    expect(choiceReason(choices[1] as Choice)).toBe('bdc has no adapter for codex yet');
    expect(choiceReason(choices[2] as Choice)).toBe('pi is not installed on this machine');
    expect(cliChoices([{ key: 'claude', installed: true }]).map((choice) => choice.key)).toEqual(['claude', 'pi']);
    expect(cliChoices(undefined).map((choice) => choice.installed)).toEqual([false, false]);
  });

  it('starts each role on the CLI this machine has: claude to think, pi to build', async () => {
    const { roleDefaults, ROLES } = await helper<SetupForm>('setup-form.js');

    const both = roleDefaults(['claude', 'pi']);
    expect(ROLES).toEqual(['pm', 'specWriter', 'planner', 'builder', 'reviewer', 'verifier']);
    expect(both['pm']).toEqual({ cli: 'claude', model: '' });
    expect(both['builder']).toEqual({ cli: 'pi', model: '' });
    expect(both['reviewer']).toEqual({ cli: 'claude', model: '' });

    expect(Object.values(roleDefaults(['pi'])).map((role) => role.cli)).toEqual(ROLES.map(() => 'pi'));
    expect(Object.values(roleDefaults([])).map((role) => role.cli)).toEqual(ROLES.map(() => 'claude'));
  });

  it('moves a role off a CLI that cannot be picked, and keeps the model it had', async () => {
    const { rolesWithChoices } = await helper<SetupForm>('setup-form.js');

    const roles = rolesWithChoices({ pm: { cli: 'claude', model: 'opus' }, builder: { cli: 'pi', model: 'fast' } }, ['pi'], 'claude');

    expect(roles['pm']).toEqual({ cli: 'pi', model: 'opus' });
    expect(roles['builder']).toEqual({ cli: 'pi', model: 'fast' });
    expect(roles['verifier']).toEqual({ cli: 'pi', model: '' });
    expect(rolesWithChoices(undefined, [], 'claude')['pm']).toEqual({ cli: 'claude', model: '' });
  });
});

describe('the lenses the form asks for', () => {
  it('starts with security, and adds a name that is a lens name', async () => {
    const { addLens, DEFAULT_LENS } = await helper<SetupForm>('setup-form.js');

    expect(DEFAULT_LENS).toBe('security');
    const added = addLens('UX', [DEFAULT_LENS]);
    expect(added).toEqual({ ok: true, lenses: ['security', 'ux'], error: '' });
  });

  it('says why a name cannot be a lens', async () => {
    const { addLens } = await helper<SetupForm>('setup-form.js');

    expect(addLens('', []).error).toBe('Type a lens name first');
    expect(addLens('has space', []).ok).toBe(false);
    expect(addLens('UPPER', []).lenses).toEqual(['upper']);
    expect(addLens('security', ['security']).error).toBe('security is already a lens');
  });

  it('lets the person take a lens away, the security preset too', async () => {
    const { removeLens } = await helper<SetupForm>('setup-form.js');

    expect(removeLens('security', ['security', 'ux'])).toEqual(['ux']);
    expect(removeLens('security', ['security'])).toEqual([]);
  });
});

describe('saving the setup', () => {
  const form: Form = {
    roles: { pm: { cli: 'claude', model: 'opus' }, builder: { cli: 'pi', model: '' } },
    lenses: ['security', 'ux'],
    checks: ['npm test', '  '],
    noVerification: false,
  };

  it('turns the form into the config bdc init takes', async () => {
    const { configFromForm, ROLES } = await helper<SetupForm>('setup-form.js');
    const roles = { ...form.roles };
    for (const role of ROLES) roles[role] = roles[role] ?? { cli: 'claude', model: '' };

    const config = configFromForm({ ...form, roles });

    expect(Object.keys(config.agents)).toEqual(ROLES);
    expect(config.agents['pm']).toEqual({ cli: 'claude', model: 'opus' });
    expect(config.lenses).toEqual({ security: { block_on: 'high' }, ux: { block_on: 'high' } });
    expect(config.verification).toEqual({ checks: [{ run: 'npm test' }] });
  });

  it('records a repo with no checks, or no verification, as not verified', async () => {
    const { configFromForm } = await helper<SetupForm>('setup-form.js');

    expect(configFromForm({ ...form, checks: [] }).verification).toBeNull();
    expect(configFromForm({ ...form, noVerification: true }).verification).toBeNull();
  });

  it('says what is missing before it can be saved', async () => {
    const { formProblem, ROLES, roleDefaults } = await helper<SetupForm>('setup-form.js');
    const roles = roleDefaults(['claude', 'pi']);

    expect(formProblem({ roles, lenses: ['security'], checks: [], noVerification: false })).toBe('Add a check, or choose No verification for this repo');
    expect(formProblem({ roles, lenses: ['security'], checks: [], noVerification: true })).toBe('');
    expect(formProblem({ roles, lenses: ['security'], checks: ['npm test'], noVerification: false })).toBe('');
    expect(formProblem({ roles: { ...roles, pm: { cli: '', model: '' } }, lenses: [], checks: ['npm test'], noVerification: false })).toBe('Choose a CLI for the PM');
    expect(ROLES.length).toBe(6);
  });

  it('runs bdc init with the config as JSON, and --force only when asked', async () => {
    const { initArgs } = await helper<SetupForm>('setup-form.js');

    expect(initArgs('/work/app', '{"agents":{}}')).toEqual(['init', '/work/app', '--config', '{"agents":{}}']);
    expect(initArgs('/work/app', '{}', { force: true })).toEqual(['init', '/work/app', '--config', '{}', '--force']);
  });
});
