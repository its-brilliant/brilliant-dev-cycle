// Types for kit/project.js: which Herdr space, folder and run the mods show.

/** The parts of `spaces()` this module reads. */
export interface SpaceLike {
  id: string;
  active: boolean;
  folder: string;
  machine?: string | null;
}

/** The project and run the UI shows. */
export interface ProjectTarget {
  root: string;
  machine: string | null;
  space: string;
  name: string;
  runId: string | null;
}

export interface ProjectHost {
  spaces(): SpaceLike[];
  /** `shared("bdc.run")` pins a run id; anything else is no pin. */
  shared(key: string): string | null;
  readTextFile(path: string, options?: { on?: string | null }): Promise<string | null>;
  exec(command: string, args?: string[], options?: { cwd?: string; on?: string | null }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export function activeSpace(spaces: SpaceLike[]): SpaceLike | null;
export function runsDir(root: string): string;
export function viewFile(root: string, runId: string): string;
export function parseRunIds(stdout: string): string[];
export function pickRun(ids: string[], pinned: unknown): string | null;
export function projectName(root: string): string;
export function resolveProject(host: ProjectHost): Promise<ProjectTarget | null>;
export function listRuns(host: ProjectHost, root: string, machine?: string | null): Promise<string[]>;
export function sameTarget(left: ProjectTarget | null, right: ProjectTarget | null): boolean;
