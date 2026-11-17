/**
 * `bdc` entry point (spec §7.2). `main` parses argv, runs one command and answers with an exit
 * code; it never calls `process.exit`, so tests drive it directly. `bin.ts` is the executable.
 */
import { USAGE, UsageError, chat, daemon, herdr, init, mcp, runs, say, send, start, status, submit, watch, type CliIO } from './commands.js';

export type { CliIO } from './commands.js';
export { USAGE } from './commands.js';

export const defaultIO: CliIO = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

/** Exit codes: 0 did it, 1 the daemon or the run said no, 2 the command line was wrong. */
export async function main(argv: string[], io: CliIO = defaultIO): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case 'init':
        return await init(args, io);
      case 'start':
        return await start(args, io);
      case 'daemon':
        return await daemon(args, io);
      case 'send':
        return await send(args);
      case 'status':
        return await status(args, io);
      case 'runs':
        return await runs(args, io);
      case 'watch':
        return await watch(args, io);
      case 'chat':
        return await chat(args, io);
      case 'say':
        return await say(args, io);
      case 'mcp':
        return await mcp(args);
      case 'submit':
        return await submit(args, io);
      case 'herdr':
        return await herdr(args, io);
      case 'help':
      case '--help':
      case '-h':
        io.out(`${USAGE}\n`);
        return 0;
      default:
        io.err(command === undefined ? `${USAGE}\n` : `bdc: unknown command: ${command}\n${USAGE}\n`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`bdc: ${error.message}\n`);
      return 2;
    }
    io.err(`bdc: ${message(error)}\n`);
    return 1;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
