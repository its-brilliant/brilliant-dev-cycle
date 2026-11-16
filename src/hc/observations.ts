/**
 * `hc events --json` lines → `AgentObservation`s for one agent terminal (spec §3.3, §5.5).
 *
 * The raw JSON-RPC shape stops here: the agent machine only ever sees observations, so a change
 * in hc's event format is a change to this file. A `status` event carries the app that reported
 * it (`bdc` is the adapter's launch marker, not the agent — the v1 pi bug); a `finished` event
 * says the terminal ended. Everything else hc emits (`created`, `foreground`, `title`, `labels`,
 * `keep`, `size`, `turn`) says nothing the completion rules need: `turn` repeats the state
 * without naming the app that reported it, so it cannot be an `OBS_STATUS`.
 */
import type { AgentObservation } from '../contracts/events.js';

/** One `hc events --json` notification, narrowed to the fields this module reads. */
interface HcEvent {
  params?: {
    terminal?: unknown;
    type?: unknown;
    data?: {
      status?: { app?: unknown; state?: unknown };
      exit_code?: unknown;
    };
  };
}

function parseHcEvent(line: string): HcEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? (parsed as HcEvent) : null;
  } catch {
    // hc can interleave a line we cannot read; losing one line must not lose the rest.
    return null;
  }
}

/**
 * `terminal` is the hc terminal of one agent job. Lines about other terminals, lines we cannot
 * parse and events without an observation in them are skipped, so the result can be fed straight
 * into the machine.
 */
export function observationsFromHcEvents(lines: string[], terminal: string): AgentObservation[] {
  const observations: AgentObservation[] = [];
  for (const line of lines) {
    const params = parseHcEvent(line)?.params;
    if (params?.terminal !== terminal) continue;
    if (params.type === 'status') {
      const status = params.data?.status;
      if (typeof status?.app === 'string' && typeof status.state === 'string') {
        observations.push({ type: 'OBS_STATUS', app: status.app, state: status.state });
      }
      continue;
    }
    if (params.type === 'finished') {
      // A killed terminal has no exit code; either way the agent's terminal is gone.
      const code = params.data?.exit_code;
      observations.push({ type: 'OBS_EXITED', code: typeof code === 'number' ? code : null });
    }
  }
  return observations;
}
