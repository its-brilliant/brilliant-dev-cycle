// `bdc` as a Herdr mod runs it.
//
// `BDC` is `./bdc-command.js`, written by `bdc herdr install` with this checkout's absolute node
// and `dist/cli/bin.js`, so a mod always runs the build the person installed. Nothing here
// imports Herdr or the command: both come in as arguments, so the argument building is plain
// JavaScript a test can check (tests/herdr/kit.test.ts).
//
// Every call is one `bdc` process (spec §7.2: the UI reads the projection and sends person
// events, never writes run files). A person event is
// `bdc send <root> <EVENT> <json payload> --run <runId>`.

/** The arguments after the command's own argv[0], for `bdc send`. Pure. */
export function sendArgs(root, event, runId) {
  const payload = { ...event };
  delete payload.type;
  const args = ['send', root, String(event.type), JSON.stringify(payload)];
  if (typeof runId === 'string' && runId !== '') args.push('--run', runId);
  return args;
}

/** `bdc start <root> "<goal>"`: creates the run and prints its id. Pure. */
export function startArgs(root, goal) {
  return ['start', root, goal];
}

/** `bdc status <root> --run <runId>`: prints the run's view as JSON. Pure. */
export function statusArgs(root, runId) {
  const args = ['status', root];
  if (typeof runId === 'string' && runId !== '') args.push('--run', runId);
  return args;
}

/**
 * The three calls the mods make, bound to one command and one host. `send` answers
 * `{ ok, error }`, `start` `{ ok, runId, error }` and `status` `{ ok, view, error }`, because
 * a mod shows a failure inline (§9.1 rule 3) instead of throwing into Herdr's console.
 */
export function bdcCommands(host, command) {
  return {
    send: (root, event, runId) => send(host, command, root, event, runId),
    start: (root, goal) => start(host, command, root, goal),
    status: (root, runId) => status(host, command, root, runId),
  };
}

export async function send(host, command, root, event, runId) {
  const result = await run(host, command, sendArgs(root, event, runId));
  return { ok: result.ok, error: result.error };
}

export async function start(host, command, root, goal) {
  const result = await run(host, command, startArgs(root, goal));
  if (!result.ok) return { ok: false, runId: null, error: result.error };
  // `bdc start` prints the new run's id and nothing else.
  return { ok: true, runId: result.out.trim().split('\n').pop() ?? '', error: '' };
}

export async function status(host, command, root, runId) {
  const result = await run(host, command, statusArgs(root, runId));
  if (!result.ok) return { ok: false, view: null, error: result.error };
  try {
    return { ok: true, view: JSON.parse(result.out), error: '' };
  } catch {
    return { ok: false, view: null, error: 'bdc answered with something that is not a run view' };
  }
}

/** One `bdc` process: `{ ok, out, error }`. A refusal is the CLI's own message, in words. */
async function run(host, command, args) {
  if (!Array.isArray(command) || command.length === 0) {
    return { ok: false, out: '', error: 'bdc is not installed for this checkout: run `bdc herdr install`' };
  }
  try {
    const result = await host.exec(command[0], [...command.slice(1), ...args]);
    if (result.code === 0) return { ok: true, out: result.stdout ?? '', error: '' };
    const said = String(result.stderr ?? '').trim();
    return { ok: false, out: result.stdout ?? '', error: said === '' ? `bdc exited with code ${result.code}` : said };
  } catch (error) {
    return { ok: false, out: '', error: error instanceof Error ? error.message : String(error) };
  }
}
