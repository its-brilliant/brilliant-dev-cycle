import { parseEnv, parseVerify } from '../config/blocks.js';
import { expectId, expectRecord, expectString, hasOwn, unknownFields } from '../fields.js';
import { got, joinPath, push, type Issue } from '../issues.js';
import { parseYaml } from '../yaml.js';
import type { Phase, PhaseTask } from './types.js';

const PHASE_KEYS = ['id', 'title', 'deps', 'tasks', 'env', 'verify'] as const;
const TASK_KEYS = ['id', 'title'] as const;

export interface PhasesParseResult {
  phases: Phase[] | null;
  issues: Issue[];
}

export function parsePhasesYaml(text: string, file = '.herd/phases.yaml'): PhasesParseResult {
  const yaml = parseYaml(text, file);
  if (yaml.issues.length > 0) return { phases: null, issues: yaml.issues };
  return parsePhasesValue(yaml.value, file);
}

export function parsePhasesValue(value: unknown, file = '.herd/phases.yaml'): PhasesParseResult {
  const issues: Issue[] = [];
  const root = expectRecord(value, file, '', issues);
  if (!root) return { phases: null, issues };

  unknownFields(root, ['phases'], file, '', issues);
  if (!hasOwn(root, 'phases')) {
    push(issues, file, 'phases', 'required');
    return { phases: null, issues };
  }
  if (!Array.isArray(root.phases)) {
    push(issues, file, 'phases', `expected a list, got ${got(root.phases)}`);
    return { phases: null, issues };
  }
  if (root.phases.length === 0) {
    push(issues, file, 'phases', 'expected at least one phase');
    return { phases: null, issues };
  }

  const phases: Phase[] = [];
  const graph: Array<{ index: number; id: string; deps: string[] }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < root.phases.length; i++) {
    const phase = parsePhase(root.phases[i], file, i, seen, graph, issues);
    if (phase) phases.push(phase);
  }

  const ids = new Set(graph.map((node) => node.id));
  for (const node of graph) {
    node.deps.forEach((dep, depIndex) => {
      if (!ids.has(dep)) {
        push(issues, file, `phases[${node.index}].deps[${depIndex}]`, `unknown phase ${JSON.stringify(dep)}`);
      }
    });
  }

  for (const cycle of findCycles(
    graph.map((node) => node.id),
    (id) => graph.find((node) => node.id === id)?.deps ?? [],
  )) {
    push(issues, file, 'phases', `cycle detected: ${cycle.join(' -> ')}`);
  }

  if (issues.length > 0) return { phases: null, issues };
  return { phases, issues };
}

function parsePhase(
  value: unknown,
  file: string,
  index: number,
  seen: Set<string>,
  graph: Array<{ index: number; id: string; deps: string[] }>,
  issues: Issue[],
): Phase | undefined {
  const path = `phases[${index}]`;
  const obj = expectRecord(value, file, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  unknownFields(obj, PHASE_KEYS, file, path, issues);

  const id = requireId(obj, 'id', file, path, issues);
  const duplicate = id !== undefined && seen.has(id);
  if (duplicate) push(issues, file, joinPath(path, 'id'), `duplicate phase id ${JSON.stringify(id)}`);
  if (id) seen.add(id);

  const title = requireField(obj, 'title', file, path, issues, expectString);
  const parsedDeps = parseDeps(obj, file, path, issues);
  const tasks = parseTasks(obj, file, path, issues);
  if (id && !duplicate) graph.push({ index, id, deps: parsedDeps.deps });
  const env = requireBlock(obj, 'env', file, path, issues, parseEnv);
  const verify = requireBlock(obj, 'verify', file, path, issues, parseVerify);

  if (
    !id ||
    title === undefined ||
    !parsedDeps.ok ||
    !tasks ||
    env === 'invalid' ||
    verify === 'invalid' ||
    issues.length > before
  ) {
    return undefined;
  }

  return { id, title, deps: parsedDeps.deps, tasks, env, verify };
}

function parseDeps(
  obj: Record<string, unknown>,
  file: string,
  path: string,
  issues: Issue[],
): { deps: string[]; ok: boolean } {
  const depsPath = joinPath(path, 'deps');
  if (!hasOwn(obj, 'deps')) {
    push(issues, file, depsPath, 'required');
    return { deps: [], ok: false };
  }
  if (!Array.isArray(obj.deps)) {
    push(issues, file, depsPath, `expected a list, got ${got(obj.deps)}`);
    return { deps: [], ok: false };
  }
  const deps: string[] = [];
  let ok = true;
  const local = new Set<string>();
  for (let i = 0; i < obj.deps.length; i++) {
    const dep = expectId(obj.deps[i], file, `${depsPath}[${i}]`, issues);
    if (dep === undefined) {
      ok = false;
      continue;
    }
    if (local.has(dep)) {
      push(issues, file, `${depsPath}[${i}]`, `duplicate dependency ${JSON.stringify(dep)}`);
      ok = false;
      continue;
    }
    local.add(dep);
    deps.push(dep);
  }
  return { deps, ok };
}

function parseTasks(
  obj: Record<string, unknown>,
  file: string,
  path: string,
  issues: Issue[],
): PhaseTask[] | undefined {
  const tasksPath = joinPath(path, 'tasks');
  if (!hasOwn(obj, 'tasks')) {
    push(issues, file, tasksPath, 'required');
    return undefined;
  }
  if (!Array.isArray(obj.tasks)) {
    push(issues, file, tasksPath, `expected a list, got ${got(obj.tasks)}`);
    return undefined;
  }
  if (obj.tasks.length === 0) {
    push(issues, file, tasksPath, 'expected at least one task');
    return undefined;
  }
  const tasks: PhaseTask[] = [];
  const used = new Set<string>();
  let ok = true;
  for (let i = 0; i < obj.tasks.length; i++) {
    const taskPath = `${tasksPath}[${i}]`;
    const parsed = parseTask(obj.tasks[i], file, taskPath, i, issues);
    if (!parsed) {
      ok = false;
      continue;
    }
    if (used.has(parsed.id)) {
      push(issues, file, taskPath, `duplicate task id ${JSON.stringify(parsed.id)}`);
      ok = false;
      continue;
    }
    used.add(parsed.id);
    tasks.push(parsed);
  }
  return ok ? tasks : undefined;
}

function parseTask(
  value: unknown,
  file: string,
  path: string,
  index: number,
  issues: Issue[],
): PhaseTask | undefined {
  if (typeof value === 'string') {
    const title = expectString(value, file, path, issues);
    return title === undefined ? undefined : { id: `t${index + 1}`, title };
  }
  const obj = expectRecord(value, file, path, issues);
  if (!obj) return undefined;
  unknownFields(obj, TASK_KEYS, file, path, issues);
  const title = requireField(obj, 'title', file, path, issues, expectString);
  let id = `t${index + 1}`;
  if (hasOwn(obj, 'id')) {
    const parsed = expectId(obj.id, file, joinPath(path, 'id'), issues);
    if (parsed === undefined || title === undefined) return undefined;
    id = parsed;
  }
  if (title === undefined) return undefined;
  return { id, title };
}

function requireId(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  base: string,
  issues: Issue[],
): string | undefined {
  const path = joinPath(base, key);
  if (!hasOwn(obj, key)) {
    push(issues, file, path, 'required');
    return undefined;
  }
  return expectId(obj[key], file, path, issues);
}

function requireField<T>(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  base: string,
  issues: Issue[],
  parse: (value: unknown, file: string, path: string, issues: Issue[]) => T | undefined,
): T | undefined {
  const path = joinPath(base, key);
  if (!hasOwn(obj, key)) {
    push(issues, file, path, 'required');
    return undefined;
  }
  return parse(obj[key], file, path, issues);
}

function requireBlock<T>(
  obj: Record<string, unknown>,
  key: 'env' | 'verify',
  file: string,
  base: string,
  issues: Issue[],
  parse: (value: unknown, file: string, path: string, issues: Issue[]) => T | undefined,
): T | 'invalid' {
  const path = joinPath(base, key);
  if (!hasOwn(obj, key)) {
    push(issues, file, path, 'required');
    return 'invalid';
  }
  const before = issues.length;
  const parsed = parse(obj[key], file, path, issues);
  if (parsed === undefined || issues.length > before) return 'invalid';
  return parsed;
}

/**
 * Cycles in the dependency graph. Each cycle is a list that starts and ends
 * at the same id, rotated to begin at the lexicographically smallest id.
 * Edges point from a phase to the phases it depends on.
 */
export function findCycles(
  order: readonly string[],
  depsOf: (id: string) => readonly string[],
): string[][] {
  const known = new Set(order);
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (id: string): void => {
    color.set(id, 1);
    stack.push(id);
    for (const next of depsOf(id)) {
      if (!known.has(next)) continue;
      const tone = color.get(next) ?? 0;
      if (tone === 0) {
        visit(next);
      } else if (tone === 1) {
        const start = stack.indexOf(next);
        const body = stack.slice(start);
        const cycle = canonicalCycle(body);
        const key = cycle.join('>');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      }
    }
    stack.pop();
    color.set(id, 2);
  };

  for (const id of order) {
    if ((color.get(id) ?? 0) === 0) visit(id);
  }
  return cycles;
}

function canonicalCycle(body: readonly string[]): string[] {
  let min = 0;
  for (let i = 1; i < body.length; i++) {
    if (body[i]! < body[min]!) min = i;
  }
  const rotated = [...body.slice(min), ...body.slice(0, min)];
  return [...rotated, rotated[0]!];
}
