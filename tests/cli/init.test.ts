/**
 * `bdc init` (spec §3.1, §7.4, §10): the project's `bdc.yaml`, written from the JSON that first
 * run's setup screen sends.
 *
 * What matters here: the file it writes is a config the daemon will read back (the YAML round
 * trips through `ProjectConfig`), a bad config is refused with its problems and writes nothing,
 * an existing `bdc.yaml` is the person's own file until `--force`, and `--print-defaults` answers
 * a whole valid config with this machine's CLIs in it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, type CliIO } from '../../src/cli/main.js';
import { CONFIG_FILE, CONFIG_HEADER, defaultAgents, defaultConfig, installedClis, parseConfigJson, readConfigYaml } from '../../src/cli/init.js';
import { ProjectConfig, ROLES, type ProjectConfig as Config } from '../../src/contracts/domain.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-init-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function captureIO(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

/** A config the setup screen would send: every role chosen, one lens, one check. */
function setupConfig(): Config {
  const agents = {} as Config['agents'];
  for (const role of ROLES) agents[role] = { cli: 'pi', model: role === 'pm' ? 'opus-5.5' : '' };
  return ProjectConfig.parse({
    agents,
    lenses: { security: { block_on: 'high' }, ux: { block_on: 'medium' } },
    verification: { checks: [{ name: 'unit', run: 'npm test' }] },
  });
}

/** A PATH holding only fake executables named `names`, so the defaults are what the test says. */
function fakePath(names: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-init-path-'));
  for (const name of names) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return dir;
}

describe('bdc init --config', () => {
  it('writes a bdc.yaml that reads back as the same config', async () => {
    const { io, out, err } = captureIO();
    const config = setupConfig();

    expect(await main(['init', root, '--config', JSON.stringify(config)], io)).toBe(0);

    expect(err).toEqual([]);
    const file = path.join(root, CONFIG_FILE);
    expect(out).toEqual([`wrote ${file}\n`]);
    const written = fs.readFileSync(file, 'utf8');
    expect(written.startsWith(CONFIG_HEADER)).toBe(true);
    expect(readConfigYaml(written)).toEqual({ ok: true, config });
  });

  it('refuses a config that is not a project config, and writes nothing', async () => {
    const { io, out, err } = captureIO();

    expect(await main(['init', root, '--config', JSON.stringify({ agents: { pm: { cli: 'claude' } } })], io)).toBe(1);

    expect(out).toEqual([]);
    expect(err.join('')).toContain('specWriter');
    expect(fs.existsSync(path.join(root, CONFIG_FILE))).toBe(false);
  });

  it('says so when the config is not JSON at all', async () => {
    const { io, err } = captureIO();

    expect(await main(['init', root, '--config', '{agents:'], io)).toBe(1);

    expect(err.join('')).toContain('not JSON');
  });

  it('never replaces a bdc.yaml that is already there unless --force', async () => {
    const file = path.join(root, CONFIG_FILE);
    fs.writeFileSync(file, '# mine\n');

    const first = captureIO();
    expect(await main(['init', root, '--config', JSON.stringify(setupConfig())], first.io)).toBe(1);
    expect(first.err.join('')).toContain('already exists');
    expect(fs.readFileSync(file, 'utf8')).toBe('# mine\n');

    const forced = captureIO();
    expect(await main(['init', root, '--config', JSON.stringify(setupConfig()), '--force'], forced.io)).toBe(0);
    expect(readConfigYaml(fs.readFileSync(file, 'utf8')).ok).toBe(true);
  });

  it('needs a folder that exists, and says which one is missing', async () => {
    const { io, err } = captureIO();

    expect(await main(['init', path.join(root, 'nope'), '--config', JSON.stringify(setupConfig())], io)).toBe(1);

    expect(err.join('')).toContain('there is no folder');
  });

  it('answers a usage problem with exit code 2', async () => {
    const missing = captureIO();
    expect(await main(['init', root], missing.io)).toBe(2);
    expect(missing.err.join('')).toContain('--config');

    const both = captureIO();
    expect(await main(['init', root, '--config', '{}', '--print-defaults'], both.io)).toBe(2);
    expect(both.err.join('')).toContain('not both');
  });
});

describe('bdc init --print-defaults', () => {
  it('prints a whole valid config, with claude thinking and pi building', async () => {
    vi.stubEnv('PATH', fakePath(['claude', 'pi']));
    const { io, out } = captureIO();

    expect(await main(['init', root, '--print-defaults'], io)).toBe(0);

    const printed = JSON.parse(out.join('')) as Config;
    expect(ProjectConfig.parse(printed)).toEqual(printed);
    expect(printed.agents.builder.cli).toBe('pi');
    expect(printed.agents.pm.cli).toBe('claude');
    expect(printed.agents.specWriter.cli).toBe('claude');
    expect(printed.agents.planner.cli).toBe('claude');
    expect(printed.agents.reviewer.cli).toBe('claude');
    expect(printed.agents.verifier.cli).toBe('claude');
    expect(printed.agents.pm.model).toBe('');
    expect(printed.lenses).toEqual({ security: { block_on: 'high', runs: 'every-phase', scope: [] } });
    expect(printed.verification).toBeNull();
  });

  it('falls back to the one CLI the machine has, for every role', async () => {
    vi.stubEnv('PATH', fakePath(['pi']));
    const { io, out } = captureIO();

    expect(await main(['init', root, '--print-defaults'], io)).toBe(0);

    const printed = JSON.parse(out.join('')) as Config;
    expect(Object.values(printed.agents).map((agent) => agent.cli)).toEqual(ROLES.map(() => 'pi'));
  });

  it('still answers a config when neither CLI is installed', () => {
    expect(installedClis({ PATH: fakePath([]) })).toEqual([]);
    expect(defaultAgents([]).pm.cli).toBe('claude');
    expect(defaultConfig([]).agents.builder.cli).toBe('claude');
  });

  it('writes nothing to the folder', async () => {
    const { io } = captureIO();

    expect(await main(['init', root, '--print-defaults'], io)).toBe(0);

    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe('what installed means', () => {
  it('finds only the supported CLIs that are executables on PATH', () => {
    const dir = fakePath(['claude', 'codex']);
    fs.writeFileSync(path.join(dir, 'pi'), 'not executable\n', { mode: 0o644 });

    expect(installedClis({ PATH: dir })).toEqual(['claude']);
    expect(installedClis({ PATH: `${dir}${path.delimiter}${fakePath(['pi'])}` })).toEqual(['claude', 'pi']);
    expect(installedClis({})).toEqual([]);
  });
});

describe('validating a config', () => {
  it('names the field that is wrong, so the person can fix it', () => {
    const bad = parseConfigJson(JSON.stringify({ agents: { pm: { cli: '' } } }));

    expect(bad.ok).toBe(false);
    expect(bad.ok ? [] : bad.problems.join(' ')).toContain('agents.pm.cli');
  });

  it('fills the defaults the schema has, so a small config is a whole one', () => {
    const agents = defaultAgents(['claude', 'pi']);
    const parsed = parseConfigJson(JSON.stringify({ agents }));

    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.config.concurrency : 0).toBe(3);
    expect(parsed.ok ? parsed.config.pr_targets : []).toEqual([{ provider: 'file', path: '.herd/pull-request.md' }]);
  });

  it('reads the YAML it writes with the same schema, and names what is missing', () => {
    const read = readConfigYaml('agents:\n  pm: { cli: claude }\n');

    expect(read.ok).toBe(false);
    expect(read.ok ? [] : read.problems.join(' ')).toContain('specWriter');
  });
});
