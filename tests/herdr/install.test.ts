/**
 * `bdc herdr install | uninstall | check` (spec §9, §12.5), on a throwaway Herdr home and a
 * throwaway `~`, so the person's app and their `~/.local/bin/bdc` are never touched.
 *
 * The checkout is a copy of this repo's `herdr-app/` plus a stub `dist/cli/question-tool.js`, so
 * the tests prove the real files are what get installed without needing a build first.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LAYOUT_FILES,
  WRAPPER_MARKER,
  bdcCommandSource,
  bdcModNames,
  checkMods,
  herdrPaths,
  installHerdr,
  uninstallHerdr,
  wrapperSource,
  type Env,
} from '../../src/herdr/install.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const NODE = '/usr/local/bin/node';
const QUESTION_TOOL = 'export function startAsk() { return {}; }\n';

let checkout: string;
let home: string;
let personHome: string;
let env: Env;

beforeEach(() => {
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-herdr-checkout-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-herdr-home-'));
  personHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-herdr-person-'));
  env = { HERDR_APP_HOME: home, HOME: personHome };
  fs.cpSync(path.join(REPO, 'herdr-app'), path.join(checkout, 'herdr-app'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'dist', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'dist', 'cli', 'question-tool.js'), QUESTION_TOOL);
});

afterEach(() => {
  fs.rmSync(checkout, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(personHome, { recursive: true, force: true });
});

/** Every file under `dir`, relative and sorted: the exact set an install left behind. */
function tree(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else found.push(relative);
    }
  };
  walk(dir, '');
  return found.sort();
}

function install(): ReturnType<typeof installHerdr> {
  return installHerdr({ repoRoot: checkout, env, node: NODE });
}

describe('where things go', () => {
  it('uses HERDR_APP_HOME, or ~/.config/herdr-app, and the person’s ~/.local/bin for the wrapper', () => {
    expect(herdrPaths({ HERDR_APP_HOME: '/apps/herdr', HOME: '/home/someone' })).toEqual({
      home: '/apps/herdr',
      mods: '/apps/herdr/mods',
      layouts: '/apps/herdr/layouts',
      wrapper: '/home/someone/.local/bin/bdc',
    });
    expect(herdrPaths({ HOME: '/home/someone' }).home).toBe('/home/someone/.config/herdr-app');
  });

  it('installs every bdc-* mod of the checkout, and only those', () => {
    expect(bdcModNames(REPO)).toEqual(['bdc-main', 'bdc-pm']);
  });
});

describe('install', () => {
  it('copies each bdc mod whole, with the kit and the compiled question tool', () => {
    const result = install();

    expect(fs.readdirSync(path.join(home, 'mods')).sort()).toEqual(['bdc-main', 'bdc-pm']);
    expect(tree(path.join(home, 'mods', 'bdc-main'))).toEqual(
      expect.arrayContaining([
        'main.js',
        'mod.json',
        'screens/goal.js',
        'screens/build.js',
        'screens/ended.js',
        'kit/bdc.js',
        'kit/project.js',
        'kit/view.js',
        'kit/look.js',
        'kit/words.js',
        'kit/host.js',
        'kit/bdc-command.js',
        'kit/question-tool.js',
      ]),
    );
    expect(tree(path.join(home, 'mods', 'bdc-pm'))).toEqual(
      expect.arrayContaining(['main.js', 'mod.json', 'kit/bdc.js', 'kit/bdc-command.js', 'kit/question-tool.js']),
    );
    // The mod folders' own files are the repo's files, byte for byte.
    expect(fs.readFileSync(path.join(home, 'mods', 'bdc-main', 'main.js'), 'utf8')).toBe(
      fs.readFileSync(path.join(checkout, 'herdr-app', 'mods', 'bdc-main', 'main.js'), 'utf8'),
    );
    expect(fs.readFileSync(path.join(home, 'mods', 'bdc-pm', 'kit', 'question-tool.js'), 'utf8')).toBe(QUESTION_TOOL);
    expect(result.installed).toEqual([path.join(home, 'mods', 'bdc-main'), path.join(home, 'mods', 'bdc-pm')]);
  });

  it('writes bdc-command.js with this checkout’s absolute node and CLI', () => {
    install();

    for (const mod of ['bdc-main', 'bdc-pm']) {
      const source = fs.readFileSync(path.join(home, 'mods', mod, 'kit', 'bdc-command.js'), 'utf8');
      expect(source).toBe(bdcCommandSource(NODE, path.join(checkout, 'dist', 'cli', 'bin.js')));
      expect(source).toContain(`export const BDC = [${JSON.stringify(NODE)}, ${JSON.stringify(path.join(checkout, 'dist', 'cli', 'bin.js'))}];`);
    }
  });

  it('copies the layout and its preview, and nothing else of the layouts folder', () => {
    const result = install();

    expect(fs.readdirSync(path.join(home, 'layouts')).sort()).toEqual([...LAYOUT_FILES].sort());
    expect(result.layoutFiles).toEqual(LAYOUT_FILES.map((file) => path.join(home, 'layouts', file)));
    expect(JSON.parse(fs.readFileSync(path.join(home, 'layouts', 'bdc.json'), 'utf8'))).toMatchObject({ id: 'root', type: 'row' });
  });

  it('writes ~/.local/bin/bdc as a two-line wrapper that runs this checkout', () => {
    const result = install();
    const wrapper = path.join(personHome, '.local', 'bin', 'bdc');

    expect(result.wrapper).toBe(wrapper);
    const text = fs.readFileSync(wrapper, 'utf8');
    expect(text).toBe(wrapperSource(NODE, path.join(checkout, 'dist', 'cli', 'bin.js')));
    expect(text).toContain(WRAPPER_MARKER);
    expect(text).toContain('exec');
    expect(fs.statSync(wrapper).mode & 0o111).not.toBe(0);
  });

  it('replaces a bdc mod folder whole, so nothing stale survives', () => {
    fs.mkdirSync(path.join(home, 'mods', 'bdc-pm'), { recursive: true });
    fs.writeFileSync(path.join(home, 'mods', 'bdc-pm', 'stale.js'), 'old\n');

    install();

    expect(fs.existsSync(path.join(home, 'mods', 'bdc-pm', 'stale.js'))).toBe(false);
  });

  it('leaves a ~/.local/bin/bdc that is not a bdc wrapper alone', () => {
    const wrapper = path.join(personHome, '.local', 'bin', 'bdc');
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(wrapper, '#!/bin/sh\nexec /opt/other/bdc "$@"\n', { mode: 0o755 });

    const result = install();

    expect(result.wrapper).toBeNull();
    expect(fs.readFileSync(wrapper, 'utf8')).toBe('#!/bin/sh\nexec /opt/other/bdc "$@"\n');
  });

  it('says to build when the compiled question tool is missing', () => {
    fs.rmSync(path.join(checkout, 'dist', 'cli', 'question-tool.js'));

    expect(() => install()).toThrow(/npm run build/);
  });
});

describe('uninstall', () => {
  it('removes exactly what it installed', () => {
    install();

    const { removed, kept } = uninstallHerdr({ repoRoot: checkout, env });

    expect(removed.sort()).toEqual(
      [
        path.join(home, 'mods', 'bdc-main'),
        path.join(home, 'mods', 'bdc-pm'),
        path.join(home, 'layouts', 'bdc.json'),
        path.join(home, 'layouts', 'bdc.svg'),
        path.join(personHome, '.local', 'bin', 'bdc'),
      ].sort(),
    );
    expect(kept).toEqual([]);
    expect(tree(home)).toEqual([]);
  });

  it('leaves every other mod, layout and wrapper alone', () => {
    install();
    fs.mkdirSync(path.join(home, 'mods', 'spaces'), { recursive: true });
    fs.writeFileSync(path.join(home, 'mods', 'spaces', 'main.js'), '// herdr\n');
    fs.writeFileSync(path.join(home, 'layouts', 'main.json'), '{}\n');
    const wrapper = path.join(personHome, '.local', 'bin', 'bdc');
    fs.writeFileSync(wrapper, '#!/bin/sh\nexec /opt/other/bdc "$@"\n', { mode: 0o755 });

    const { removed, kept } = uninstallHerdr({ repoRoot: checkout, env });

    expect(removed).not.toContain(path.join(home, 'mods', 'spaces'));
    expect(removed).not.toContain(path.join(home, 'layouts', 'main.json'));
    expect(kept).toEqual([wrapper]);
    expect(tree(home)).toEqual(['layouts/main.json', 'mods/spaces/main.js']);
    expect(fs.existsSync(wrapper)).toBe(true);
  });

  it('is quiet when there is nothing to remove', () => {
    expect(uninstallHerdr({ repoRoot: checkout, env })).toEqual({ removed: [], kept: [] });
  });
});

describe('check', () => {
  it('reports herdr-app missing instead of pretending a mod passed', () => {
    const report = checkMods([path.join(home, 'mods', 'bdc-main')], { home, env: { ...env, PATH: '/nonexistent' } });

    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.ok).toBe(false);
    expect(report.checks[0]?.output).toContain('herdr-app');
  });
});
