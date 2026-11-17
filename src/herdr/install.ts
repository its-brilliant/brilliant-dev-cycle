/**
 * `bdc herdr install | uninstall | check` (spec §9, §12.5): put the bdc Herdr layout and mods in
 * the person's Herdr home, take them out again, and check that every mod loads.
 *
 * An install copies `herdr-app/mods/bdc-*` into `<herdr home>/mods/`, gives each copy the shared
 * kit and the compiled question tool, writes `kit/bdc-command.js` with this checkout's absolute
 * node and `dist/cli/bin.js` (so a mod always runs the build the person installed), and copies
 * `herdr-app/layouts/bdc.json` and its preview. It never touches another mod or layout, and it
 * writes `~/.local/bin/bdc` only when that file is missing or is a bdc wrapper already.
 *
 * The files and the checks are separate functions: `installHerdr` writes files, `checkMods` runs
 * `herdr-app check`, and the CLI composes them, so the tests can prove the file behaviour without
 * the app (tests/herdr/install.test.ts).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `process.env`, or any slice of it: tests pass their own so the real home is never written. */
export type Env = Record<string, string | undefined>;

/** The layout this checkout ships: the file Herdr shows and the picture settings shows for it. */
export const LAYOUT_FILES = ['bdc.json', 'bdc.svg'];

/** The line that marks a `~/.local/bin/bdc` this command wrote, and only such a file is replaced. */
export const WRAPPER_MARKER = '# bdc wrapper (written by `bdc herdr install`)';

export interface HerdrPaths {
  /** `$HERDR_APP_HOME`, or `~/.config/herdr-app`. */
  home: string;
  /** `<home>/mods` */
  mods: string;
  /** `<home>/layouts` */
  layouts: string;
  /** `~/.local/bin/bdc` */
  wrapper: string;
}

export interface InstallOptions {
  /** The checkout to install from: its `herdr-app/` and `dist/` are what get installed. */
  repoRoot: string;
  env?: Env;
  /** The node that runs the CLI; `process.execPath` unless a test says otherwise. */
  node?: string;
}

export interface InstallResult extends Omit<HerdrPaths, 'wrapper'> {
  /** The mod folders written, absolute. */
  installed: string[];
  /** The layout files written, absolute. */
  layoutFiles: string[];
  /** The wrapper written, or null when an existing file that is not ours was left alone. */
  wrapper: string | null;
}

export interface ModCheck {
  mod: string;
  ok: boolean;
  output: string;
}

export interface CheckReport {
  checks: ModCheck[];
  ok: boolean;
}

/** The Herdr home: `HERDR_APP_HOME`, or `~/.config/herdr-app`. */
export function herdrPaths(env: Env = process.env): HerdrPaths {
  const configured = env['HERDR_APP_HOME'];
  const home =
    configured === undefined || configured.trim() === ''
      ? path.join(env['HOME'] ?? os.homedir(), '.config', 'herdr-app')
      : path.resolve(configured);
  return {
    home,
    mods: path.join(home, 'mods'),
    layouts: path.join(home, 'layouts'),
    wrapper: path.join(env['HOME'] ?? os.homedir(), '.local', 'bin', 'bdc'),
  };
}

/** The checkout this module was built from (`src/herdr/` and `dist/herdr/` are both two deep). */
export function repoRootFrom(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL('../../', moduleUrl));
}

/** The bdc mod folders of this checkout, by name, sorted. */
export function bdcModNames(repoRoot: string): string[] {
  const mods = path.join(repoRoot, 'herdr-app', 'mods');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(mods, { withFileTypes: true });
  } catch {
    throw new Error(`no herdr-app/mods in ${repoRoot}; run this from a bdc checkout`);
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('bdc-'))
    .map((entry) => entry.name)
    .sort();
}

/** `kit/bdc-command.js`: this checkout's node and CLI, as the mods run them. */
export function bdcCommandSource(node: string, cli: string): string {
  return [
    '// Written by `bdc herdr install`: this checkout\'s node and CLI, so every mod runs the same',
    '// build the person installed. Not edited by hand: install rewrites it.',
    `export const BDC = [${JSON.stringify(node)}, ${JSON.stringify(cli)}];`,
    '',
  ].join('\n');
}

/** The `~/.local/bin/bdc` wrapper: two lines that run this checkout's CLI with this node. */
export function wrapperSource(node: string, cli: string): string {
  return `#!/bin/sh\n${WRAPPER_MARKER}\nexec ${shellQuote(node)} ${shellQuote(cli)} "$@"\n`;
}

/**
 * Install the layout and the mods into the person's Herdr home. Every bdc mod folder is replaced
 * whole (it is ours), and every other mod and layout is left exactly as it was.
 */
export function installHerdr(options: InstallOptions): InstallResult {
  const env = options.env ?? process.env;
  const paths = herdrPaths(env);
  const repoRoot = path.resolve(options.repoRoot);
  const node = options.node ?? process.execPath;
  const cli = path.join(repoRoot, 'dist', 'cli', 'bin.js');
  const questionTool = path.join(repoRoot, 'dist', 'cli', 'question-tool.js');
  if (!fs.existsSync(questionTool)) {
    throw new Error(`no ${path.relative(repoRoot, questionTool)}; run \`npm run build\` first`);
  }

  const kit = path.join(repoRoot, 'herdr-app', 'kit');
  const installed: string[] = [];
  for (const name of bdcModNames(repoRoot)) {
    const target = path.join(paths.mods, name);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(path.join(repoRoot, 'herdr-app', 'mods', name), target, { recursive: true });
    fs.cpSync(kit, path.join(target, 'kit'), { recursive: true });
    fs.writeFileSync(path.join(target, 'kit', 'bdc-command.js'), bdcCommandSource(node, cli));
    fs.copyFileSync(questionTool, path.join(target, 'kit', 'question-tool.js'));
    installed.push(target);
  }

  fs.mkdirSync(paths.layouts, { recursive: true });
  const layoutFiles: string[] = [];
  for (const file of LAYOUT_FILES) {
    const target = path.join(paths.layouts, file);
    fs.copyFileSync(path.join(repoRoot, 'herdr-app', 'layouts', file), target);
    layoutFiles.push(target);
  }

  return { ...paths, installed, layoutFiles, wrapper: writeWrapper(paths.wrapper, node, cli) };
}

/** Remove exactly what `installHerdr` writes, and nothing else. */
export function uninstallHerdr(options: { repoRoot: string; env?: Env }): { removed: string[]; kept: string[] } {
  const env = options.env ?? process.env;
  const paths = herdrPaths(env);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const name of bdcModNames(path.resolve(options.repoRoot))) {
    const target = path.join(paths.mods, name);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  for (const file of LAYOUT_FILES) {
    const target = path.join(paths.layouts, file);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { force: true });
    removed.push(target);
  }
  if (fs.existsSync(paths.wrapper)) {
    if (isBdcWrapper(paths.wrapper)) {
      fs.rmSync(paths.wrapper, { force: true });
      removed.push(paths.wrapper);
    } else {
      // Someone else's bdc: not ours to delete.
      kept.push(paths.wrapper);
    }
  }
  return { removed, kept };
}

/**
 * `herdr-app check` on each mod folder: it loads the mod and its first description for real, so a
 * mod that throws on load or draws nothing fails here (§12.5). Never a running window.
 */
export function checkMods(mods: string[], options: { home: string; env?: Env }): CheckReport {
  const checks = mods.map((mod) => {
    const result = spawnSync('herdr-app', ['check', mod], {
      encoding: 'utf8',
      env: { ...(options.env ?? process.env), HERDR_APP_HOME: options.home },
      timeout: 60_000,
    });
    if (result.error !== undefined) {
      return { mod, ok: false, output: `could not run herdr-app: ${result.error.message}` };
    }
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    return { mod, ok: result.status === 0, output: output === '' ? `exit code ${result.status}` : output };
  });
  return { checks, ok: checks.every((check) => check.ok) };
}

/**
 * `bdc herdr check`: assemble this checkout's mods into a throwaway Herdr home (with the kit, the
 * generated command and the compiled question tool) and check each one there. Nothing of the
 * person's home is read or written.
 */
export function stageForCheck(options: InstallOptions): { home: string; mods: string[]; cleanup(): void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-herdr-check-'));
  const env = { ...(options.env ?? process.env), HERDR_APP_HOME: home, HOME: home };
  const installed = installHerdr({ ...options, env });
  return {
    home,
    mods: installed.installed,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

/** Write the wrapper when it is missing or ours; answer null when a foreign file stays. */
function writeWrapper(wrapper: string, node: string, cli: string): string | null {
  if (fs.existsSync(wrapper) && !isBdcWrapper(wrapper)) return null;
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(wrapper, wrapperSource(node, cli), { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

/** A `bdc` in `~/.local/bin` that this command wrote (it carries the marker line). */
function isBdcWrapper(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8').includes(WRAPPER_MARKER);
  } catch {
    return false;
  }
}

/** One shell word, quoted only when it needs it. */
function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./@%+,:=^-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
