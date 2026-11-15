#!/usr/bin/env node
/**
 * Process entry. Always runs the CLI.
 *
 * Do not decide that by comparing `argv[1]` with `import.meta.url`. On macOS
 * `/tmp` is a symlink to `/private/tmp`, so those strings differ and the
 * process used to exit 0 without running a command.
 */
import { main } from './cli.js';

let code = 1;
try {
  const result = main(process.argv);
  if (typeof result === 'number') {
    code = result;
  } else {
    console.error('bdc: no command ran');
    code = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  code = 1;
}

process.exit(code);
