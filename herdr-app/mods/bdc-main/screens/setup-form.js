// The setup form's plain parts (spec §3.1, §7.4): which CLIs a role can have, the starting choices
// for this machine, and the config JSON that `bdc init` is run with.
//
// Nothing here imports Herdr or gpui-kit, so tests/herdr/screens-u2.test.ts drives it directly
// (the screen around it, screens/setup.js, is what draws it).

/** The roles of §3.1, in the order the setup screen asks for them, with the words it shows. */
export const ROLE_FIELDS = [
  { role: 'pm', label: 'PM', hint: 'Talks to you, grills you on the goal, decides on a blocked phase.' },
  { role: 'specWriter', label: 'Spec writer', hint: 'Writes and revises the spec from your comments.' },
  { role: 'planner', label: 'Planner', hint: 'Turns the approved spec into phases and tasks.' },
  { role: 'builder', label: 'Builder', hint: 'Builds one task in its own worktree; fixes what the PM sends back.' },
  { role: 'reviewer', label: 'Reviewer', hint: 'One per lens, reviews a phase through that lens only.' },
  { role: 'verifier', label: 'Verifier', hint: 'Produces the proof a command cannot: screenshots, e2e runs.' },
];

/** The roles, in that order. */
export const ROLES = ROLE_FIELDS.map((field) => field.role);

/** The CLIs bdc has an adapter for (§3.1: claude and pi in v2.0). */
export const SUPPORTED = ['claude', 'pi'];

/** The starting lens: on for every project, blocking at high (§8). */
export const DEFAULT_LENS = 'security';

/** A lens name, as `bdc.yaml` and the lens prompt files take it. */
const LENS_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The CLIs the setup screen offers: every agent Herdr knows (`knownAgents()`), each saying whether
 * it is installed and whether bdc has an adapter for it. A supported CLI Herdr does not list is
 * still offered, as not installed, so the row never disappears.
 */
export function cliChoices(known) {
  const choices = [];
  for (const agent of Array.isArray(known) ? known : []) {
    const key = String(agent?.key ?? '');
    if (key === '' || choices.some((choice) => choice.key === key)) continue;
    choices.push({
      key,
      name: String(agent?.name ?? key),
      installed: agent?.installed === true,
      supported: SUPPORTED.includes(key),
    });
  }
  for (const cli of SUPPORTED) {
    if (!choices.some((choice) => choice.key === cli)) choices.push({ key: cli, name: cli, installed: false, supported: true });
  }
  return choices;
}

/** Why a CLI cannot be picked, in words, or '' when it can (§9.1 rule 3). */
export function choiceReason(choice) {
  if (choice?.supported !== true) return `bdc has no adapter for ${choice?.key ?? 'that CLI'} yet`;
  if (choice?.installed !== true) return `${choice?.key ?? 'that CLI'} is not installed on this machine`;
  return '';
}

/** The CLIs a person can pick now. */
export function pickableClis(choices) {
  return (Array.isArray(choices) ? choices : []).filter((choice) => choiceReason(choice) === '').map((choice) => choice.key);
}

/**
 * The starting choice per role: claude for the PM, the spec writer, the planner, the reviewer and
 * the verifier; pi for the builder; whichever of the two is installed when only one is. A role's
 * model starts empty, which means the CLI's own default (§3.1).
 */
export function roleDefaults(installed) {
  const has = (cli) => Array.isArray(installed) && installed.includes(cli);
  const any = SUPPORTED.find(has) ?? SUPPORTED[0];
  const thinking = has('claude') ? 'claude' : any;
  const building = has('pi') ? 'pi' : any;
  const roles = {};
  for (const role of ROLES) roles[role] = { cli: role === 'builder' ? building : thinking, model: '' };
  return roles;
}

/** The roles as the form holds them, with a CLI that is not offered any more moved to the first usable one. */
export function rolesWithChoices(roles, pickable, fallback) {
  const usable = Array.isArray(pickable) && pickable.length > 0 ? pickable : [fallback];
  const next = {};
  for (const role of ROLES) {
    const current = roles?.[role] ?? {};
    const cli = usable.includes(current.cli) ? current.cli : usable[0];
    next[role] = { cli, model: String(current.model ?? '') };
  }
  return next;
}

/** Add a lens by name: `{ ok, lenses, error }`, the list unchanged when the name is not one. */
export function addLens(name, lenses) {
  const list = Array.isArray(lenses) ? lenses : [];
  const lens = String(name ?? '').trim().toLowerCase();
  if (lens === '') return { ok: false, lenses: list, error: 'Type a lens name first' };
  if (!LENS_NAME.test(lens)) return { ok: false, lenses: list, error: 'A lens name is lowercase letters, numbers and dashes, up to 40' };
  if (list.includes(lens)) return { ok: false, lenses: list, error: `${lens} is already a lens` };
  return { ok: true, lenses: [...list, lens], error: '' };
}

/** Remove a lens by name; the security preset can go too, it is only a starting point. */
export function removeLens(name, lenses) {
  return (Array.isArray(lenses) ? lenses : []).filter((lens) => lens !== name);
}

/** Why the form cannot be saved yet, in words, or '' when it can (§9.1 rule 3). */
export function formProblem(form) {
  const roles = form?.roles ?? {};
  for (const role of ROLES) {
    const cli = String(roles[role]?.cli ?? '');
    if (cli === '') return `Choose a CLI for the ${labelOf(role)}`;
  }
  const checks = (form?.checks ?? []).filter((check) => String(check).trim() !== '');
  if (form?.noVerification !== true && checks.length === 0) return 'Add a check, or choose No verification for this repo';
  return '';
}

/** A role's name in words. */
export function labelOf(role) {
  return ROLE_FIELDS.find((field) => field.role === role)?.label ?? String(role);
}

/**
 * The config JSON `bdc init --config` takes, built from the form: every role's CLI and model, the
 * lenses at their starting settings, and the verification setup (§7.4) as this screen can set it:
 * the repo's own checks. Setup, ready and teardown come with the Verify screen (slice 6), so a
 * form with no checks is a repo recorded as not verified.
 */
export function configFromForm(form) {
  const roles = form?.roles ?? {};
  const agents = {};
  for (const role of ROLES) {
    agents[role] = { cli: String(roles[role]?.cli ?? ''), model: String(roles[role]?.model ?? '') };
  }
  const lenses = {};
  for (const lens of form?.lenses ?? []) lenses[lens] = { block_on: 'high' };
  const checks = (form?.checks ?? []).map((run) => ({ run: String(run).trim() })).filter((check) => check.run !== '');
  return {
    agents,
    lenses,
    verification: form?.noVerification === true || checks.length === 0 ? null : { checks },
  };
}

/** The arguments after `bdc`'s own argv[0] that write the config: `bdc init <root> --config <json>`. */
export function initArgs(root, configJson, options = {}) {
  const args = ['init', String(root), '--config', String(configJson)];
  if (options.force === true) args.push('--force');
  return args;
}
