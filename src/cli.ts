#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UNIMPLEMENTED_PHASES } from './later.js';
import { formatIssue } from './issues.js';
import { validateProject } from './project.js';
import { packageVersion } from './version.js';

const HELP = `bdc — brilliant-dev-cycle orchestrator

Usage:
  bdc validate <dir>    Validate bdc.yaml and the .herd/ file model
  bdc --help            Show this help
  bdc --version         Print the version

p1-core covers the config parser, the .herd file model, and validate.
Not in this build: ${UNIMPLEMENTED_PHASES.map((phase) => phase.id).join(', ')}.
`;

/** Run the CLI. Returns a process exit code. */
export function main(argv: readonly string[]): number {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP.trimEnd());
    return 0;
  }
  if (args[0] === '--version' || args[0] === '-V') {
    console.log(packageVersion());
    return 0;
  }
  if (args[0] !== 'validate') {
    console.error(`unknown command ${JSON.stringify(args[0])}`);
    console.error('Run bdc --help for usage.');
    return 2;
  }
  if (args.length !== 2 || args[1] === undefined || args[1] === '') {
    console.error('validate requires one directory');
    return 2;
  }
  const dir = args[1];
  const issues = validateProject(dir);
  if (issues.length === 0) {
    console.log(`valid: ${dir}`);
    return 0;
  }
  for (const issue of issues) console.error(formatIssue(issue, dir));
  return 1;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) {
  process.exit(main(process.argv));
}
