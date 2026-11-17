// Setup (spec §3.1, §7.4; frames 11c/12): the active space's folder has no `bdc.yaml` yet, so
// this is where the project is made. One card per role, with the CLI bdc can actually run and the
// model that CLI takes; the review lenses; and how this repo is checked. "Save and continue" runs
// `bdc init <root> --config <json>` (src/cli/init.ts), and the router's project watch then finds
// the new `bdc.yaml` and moves the main area on to the goal.
//
// Two rules shape the code here. §9.1 rule 3: every control does something now, and a disabled one
// says why in words next to it. Herdr's rule: a text field's state is created in a handler, never
// in render, so the model, a lens name and a check each open a field on a click.
import { div } from "gpui-kit";
import { Input, h_flex, v_flex } from "gpui-base";
import { knownAgents } from "herdr";
import { BDC } from "../kit/bdc-command.js";
import { host } from "../kit/host.js";
import { activeSpace } from "../kit/project.js";
import {
  DEFAULT_LENS,
  ROLE_FIELDS,
  SUPPORTED,
  addLens,
  choiceReason,
  cliChoices,
  configFromForm,
  formProblem,
  initArgs,
  pickableClis,
  removeLens,
  roleDefaults,
  rolesWithChoices,
} from "./setup-form.js";

export function render(_view, ctx) {
  const t = ctx.t;
  loadAgentsOnce(ctx);
  const root = folderNow();
  const form = formOf(ctx);
  const choices = ctx.state.agents;
  const problem = formProblem(form);
  const saving = ctx.state.saving === true;
  return v_flex()
    .id("bdc-setup")
    .flex_1()
    .min_h(0)
    .gap(12)
    .overflow_y_scrollbar()
    .child(div().text_size(20).font_semibold().child("Set up this project"))
    .child(
      t.label(
        root === ''
          ? "bdc works in a folder that has a bdc.yaml. The space you are in has no folder, so pick one from the sidebar first."
          : "This folder has no bdc.yaml yet. Choose who does each job, and how this repo is checked. Everything here goes into bdc.yaml and can change later.",
      ),
    )
    .when(root !== '', (column) => column.child(t.label(root, { color: t.colors.dim, size: t.type.small, wrap: false })))
    .when(root !== '', (column) =>
      column.child(
        t.card(
          t.section("Agents"),
          t.label("Each role runs one CLI in its own terminal. A model left empty is that CLI's own default."),
          ...ROLE_FIELDS.map((field) => roleCard(t, ctx, field, form, choices)),
        ),
      ),
    )
    .when(root !== '', (column) => column.child(lensCard(t, ctx, form)))
    .when(root !== '', (column) => column.child(verificationCard(t, ctx, form)))
    .when(root !== '', (column) =>
      column.child(
        h_flex()
          .gap(10)
          .items_center()
          .child(
            t
              .button(saving ? "Saving…" : "Save and continue", {
                id: "bdc-setup-save",
                primary: true,
                disabled: saving || problem !== '' || choices === undefined,
                reason: saving ? "Writing bdc.yaml" : choices === undefined ? "Checking which CLIs are installed" : problem,
              })
              .on_click((_event, cx) => save(ctx, cx)),
          )
          .when(problem !== '' && choices !== undefined, (row) => row.child(t.label(problem, { color: t.colors.dim, size: t.type.small })))
          .when(ctx.state.error !== undefined && ctx.state.error !== '', (row) => row.child(div().text_size(t.type.small).text_color(t.colors.blocked).child(ctx.state.error))),
      ),
    );
}

/** The project folder the setup writes to: the active space's folder (there is no bdc.yaml yet). */
function folderNow() {
  if (host.checking()) return "";
  try {
    const space = activeSpace(host.spaces());
    return typeof space?.folder === "string" ? space.folder : "";
  } catch {
    return "";
  }
}

/** The form as it stands: the screen's own state, with the starting values the first render has. */
function formOf(ctx) {
  const state = ctx.state;
  const pickable = pickableFor(state);
  const roles = rolesWithChoices(state.roles ?? roleDefaults(pickable), pickable, "claude");
  return {
    roles,
    lenses: Array.isArray(state.lenses) ? state.lenses : [DEFAULT_LENS],
    checks: Array.isArray(state.checks) ? state.checks : [],
    noVerification: state.noVerification === true,
  };
}

/** The CLIs a role can have: installed and supported, or the supported ones when the check failed. */
function pickableFor(state) {
  if (typeof state.agentsError === "string" && state.agentsError !== "") return [...SUPPORTED];
  return pickableClis(state.agents ?? []);
}

/**
 * Ask Herdr once which agents are installed. A screen has no `init`, so this happens on the first
 * render: the marker is set before the task starts, so later renders do not ask again.
 */
function loadAgentsOnce(ctx) {
  if (ctx.state.agentsLoaded === true || host.checking()) return;
  ctx.setState({ agentsLoaded: true });
  ctx.cx.spawn(async (asyncCx) => {
    try {
      const known = await knownAgents();
      ctx.setState({ agents: cliChoices(known), agentsError: "" }, asyncCx);
    } catch (error) {
      ctx.setState({ agents: cliChoices([]), agentsError: `bdc could not ask which CLIs are installed: ${message(error)}` }, asyncCx);
    }
  });
}

/**
 * The InputState a field renders from, created here in the handler that opens the field: Herdr's
 * rule is that retained text state is made in a handler or init, never in render. `ctx.inputs` is
 * this view's own map of them, so a second click on the same field finds the same one.
 */
function fieldInput(ctx, name, value, cx) {
  const first = ctx.inputs[name] === undefined;
  const input = ctx.input(name, cx);
  if (first) input.set_value(value ?? "");
  return input;
}

// ── agents ──────────────────────────────────────────────────────────────────────────────────

/**
 * One role as one compact row: what it does, its CLI (a dropdown), its model. The "Same as PM" and
 * "Same as builder" buttons are gone: with a dropdown per role they were extra clicks, not help.
 */
function roleCard(t, ctx, field, form, choices) {
  const chosen = form.roles[field.role] ?? { cli: "", model: "" };
  const editing = ctx.state.modelFor === field.role;
  return v_flex()
    .gap(6)
    .py(8)
    .border_b(1)
    .border_color(t.colors.border)
    .child(
      h_flex()
        .gap(12)
        .items_center()
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(div().text_size(t.type.ui).font_semibold().text_color(t.colors.fg).child(field.label))
            .child(div().text_size(t.type.small).text_color(t.colors.dim).truncate().child(field.hint)),
        )
        .child(
          choices === undefined
            ? t.label("Checking which CLIs are installed…", { color: t.colors.dim, size: t.type.small, wrap: false })
            : cliRow(t, ctx, field.role, chosen, choices, form),
        )
        .child(modelButton(t, ctx, field.role, chosen)),
    )
    .when(editing, (column) => column.child(modelRow(t, ctx, field.role, chosen, editing)));
}

/** The model on a small button: "default model" until the person picks one. */
function modelButton(t, ctx, role, chosen) {
  const words = chosen.model === "" ? "default model" : chosen.model;
  return div()
    .id(`bdc-setup-model-${role}`)
    .w(170)
    .h(28)
    .px(10)
    .flex()
    .items_center()
    .rounded(t.radii.input)
    .border(1)
    .border_color(t.colors.input)
    .bg(t.colors.bg)
    .cursor_pointer()
    .hover((style) => style.bg(t.colors.raised))
    .on_click((_event, cx) => openModel(ctx, role, chosen, cx))
    .child(div().truncate().text_size(t.type.small).text_color(chosen.model === "" ? t.colors.dim : t.colors.fg).child(words));
}

/**
 * The CLI choice as a dropdown: only the CLIs bdc can run (installed and supported). The others are
 * one quiet line in the list, not a wall of disabled chips (Yoni, 17 Nov 2026: "should be a dropdown").
 */
function cliRow(t, ctx, role, chosen, choices, form) {
  const pickable = choices.filter((choice) => choiceReason(choice) === "" && choice.installed !== false);
  const others = choices.filter((choice) => choice.supported !== true).length;
  return t.dropdown(`bdc-setup-cli-${role}`, {
    value: chosen.cli,
    choices: pickable.map((choice) => ({ key: choice.key, label: choice.name ?? choice.key })),
    open: ctx.state.cliOpen === role,
    placeholder: pickable.length === 0 ? "No supported CLI is installed" : "Choose a CLI",
    note: others > 0 ? `bdc runs claude and pi for now; ${others} other agent CLI${others === 1 ? "" : "s"} on this Mac are not supported yet.` : "",
    onToggle: (open, cx) => ctx.setState({ cliOpen: open ? role : "" }, cx),
    onPick: (key, cx) => {
      ctx.setState({ cliOpen: "" }, cx);
      chooseCli(ctx, role, key, form, cx);
    },
  });
}

/** The model: the choice's own default until the person opens the field and types one. */
function modelRow(t, ctx, role, chosen, editing) {
  const field = ctx.inputs["setup.model"];
  if (!editing || field === undefined) return div();
  return v_flex()
    .gap(6)
    .child(
      Input.new(field)
        .h(28)
        .px(8)
        .rounded(t.radii.input)
        .border(1)
        .border_color(t.colors.input)
        .bg(t.colors.bg)
        .text_size(t.type.ui)
        .text_color(t.colors.fg),
    )
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(t.button("Use this model", { id: `bdc-setup-model-done-${role}`, primary: true }).on_click((_event, cx) => commitModel(ctx, role, cx)))
        .child(t.button("Cancel", { id: `bdc-setup-model-cancel-${role}` }).on_click((_event, cx) => ctx.setState({ modelFor: "" }, cx)))
        .child(t.label("Empty means the CLI's own default.", { color: t.colors.dim, size: t.type.tiny })),
    );
}

function chooseCli(ctx, role, cli, form, cx) {
  ctx.setState({ roles: { ...form.roles, [role]: { cli, model: form.roles[role]?.model ?? "" } } }, cx);
}


function openModel(ctx, role, chosen, cx) {
  fieldInput(ctx, "setup.model", chosen.model, cx).focus();
  ctx.setState({ modelFor: role }, cx);
}

function commitModel(ctx, role, cx) {
  const form = formOf(ctx);
  const model = ctx.input("setup.model", cx).value().trim();
  ctx.setState({ roles: { ...form.roles, [role]: { cli: form.roles[role]?.cli ?? "", model } }, modelFor: "" }, cx);
}

// ── lenses ──────────────────────────────────────────────────────────────────────────────────

function lensCard(t, ctx, form) {
  const adding = ctx.state.addingLens === true;
  const rows = [
    t.section("Review lenses"),
    t.label("One reviewer per lens, each with the prompt you write for it. Every phase is reviewed through every lens; a lens blocks from the level it names."),
    h_flex()
      .gap(6)
      .flex_wrap()
      .children(
        form.lenses.map((lens) =>
          h_flex()
            .id(`bdc-setup-lens-${lens}`)
            .h(24)
            .px(8)
            .gap(6)
            .items_center()
            .rounded(t.radii.pill)
            .border(1)
            .border_color(t.colors.input)
            .bg(t.colors.bg)
            .child(div().text_size(t.type.small).text_color(t.colors.fg).child(`${lens} · blocks at high`))
            .child(
              div()
                .id(`bdc-setup-lens-remove-${lens}`)
                .cursor_pointer()
                .text_size(t.type.small)
                .text_color(t.colors.dim)
                .hover((style) => style.text_color(t.colors.blocked))
                .child("×")
                .on_click((_event, cx) => ctx.setState({ lenses: removeLens(lens, form.lenses) }, cx)),
            ),
        ),
      ),
    adding ? addLensRow(t, ctx) : t.button("Add lens", { id: "bdc-setup-add-lens" }).on_click((_event, cx) => openLens(ctx, cx)),
  ];
  if (ctx.state.lensError !== undefined && ctx.state.lensError !== "") {
    rows.push(div().text_size(t.type.small).text_color(t.colors.blocked).child(ctx.state.lensError));
  }
  return t.card(...rows);
}

function addLensRow(t, ctx) {
  const field = ctx.inputs["setup.lens"];
  if (field === undefined) return div();
  return v_flex()
    .gap(6)
    .child(
      Input.new(field)
        .h(28)
        .px(8)
        .rounded(t.radii.input)
        .border(1)
        .border_color(t.colors.input)
        .bg(t.colors.bg)
        .text_size(t.type.ui)
        .text_color(t.colors.fg),
    )
    .child(
      h_flex()
        .gap(6)
        .child(t.button("Add", { id: "bdc-setup-lens-add", primary: true }).on_click((_event, cx) => commitLens(ctx, cx)))
        .child(t.button("Cancel", { id: "bdc-setup-lens-cancel" }).on_click((_event, cx) => ctx.setState({ addingLens: false, lensError: "" }, cx)))
        .child(t.label("A lens name is lowercase letters, numbers and dashes.", { color: t.colors.dim, size: t.type.tiny })),
    );
}

function openLens(ctx, cx) {
  fieldInput(ctx, "setup.lens", "", cx).focus();
  ctx.setState({ addingLens: true, lensError: "" }, cx);
}

function commitLens(ctx, cx) {
  const form = formOf(ctx);
  const added = addLens(ctx.input("setup.lens", cx).value(), form.lenses);
  ctx.setState({ lenses: added.lenses, lensError: added.error, addingLens: !added.ok }, cx);
  if (added.ok) ctx.input("setup.lens", cx).set_value("");
}

// ── verification ───────────────────────────────────────────────────────────────────────────

function verificationCard(t, ctx, form) {
  const rows = [t.section("Verification"), t.label("The checks every phase runs on top of its own. Setup, ready and teardown come with the Verify screen.")];
  if (form.noVerification) {
    rows.push(t.label("No verification for this repo. The pull request will say so.", { color: t.colors.working }));
    rows.push(t.button("Run checks instead", { id: "bdc-setup-verify-on" }).on_click((_event, cx) => ctx.setState({ noVerification: false }, cx)));
    return t.card(...rows);
  }
  if (form.checks.length === 0) rows.push(t.label("No checks yet.", { color: t.colors.dim, size: t.type.small }));
  form.checks.forEach((check, index) => {
    rows.push(
      h_flex()
        .gap(8)
        .items_center()
        .child(div().flex_1().min_w(0).font_family(t.mono).text_size(t.type.small).text_color(t.colors.fg).child(check))
        .child(
          div()
            .id(`bdc-setup-check-remove-${index}`)
            .cursor_pointer()
            .text_size(t.type.small)
            .text_color(t.colors.dim)
            .hover((style) => style.text_color(t.colors.blocked))
            .child("×")
            .on_click((_event, cx) => ctx.setState({ checks: form.checks.filter((_, at) => at !== index) }, cx)),
        ),
    );
  });
  rows.push(ctx.state.addingCheck === true ? addCheckRow(t, ctx) : t.button("Add check", { id: "bdc-setup-add-check" }).on_click((_event, cx) => openCheck(ctx, cx)));
  rows.push(
    t
      .button("No verification for this repo", { id: "bdc-setup-verify-off" })
      .on_click((_event, cx) => ctx.setState({ noVerification: true, addingCheck: false, checks: [] }, cx)),
  );
  return t.card(...rows);
}

function addCheckRow(t, ctx) {
  const field = ctx.inputs["setup.check"];
  if (field === undefined) return div();
  return v_flex()
    .gap(6)
    .child(
      Input.new(field)
        .h(28)
        .px(8)
        .rounded(t.radii.input)
        .border(1)
        .border_color(t.colors.input)
        .bg(t.colors.bg)
        .text_size(t.type.ui)
        .text_color(t.colors.fg),
    )
    .child(
      h_flex()
        .gap(6)
        .child(t.button("Add", { id: "bdc-setup-check-add", primary: true }).on_click((_event, cx) => commitCheck(ctx, cx)))
        .child(t.button("Cancel", { id: "bdc-setup-check-cancel" }).on_click((_event, cx) => ctx.setState({ addingCheck: false }, cx)))
        .child(t.label("One command, run in every phase's worktree.", { color: t.colors.dim, size: t.type.tiny })),
    );
}

function openCheck(ctx, cx) {
  fieldInput(ctx, "setup.check", "", cx).focus();
  ctx.setState({ addingCheck: true }, cx);
}

function commitCheck(ctx, cx) {
  const form = formOf(ctx);
  const command = ctx.input("setup.check", cx).value().trim();
  if (command === "") return;
  ctx.setState({ checks: [...form.checks, command], addingCheck: false }, cx);
  ctx.input("setup.check", cx).set_value("");
}

// ── save ───────────────────────────────────────────────────────────────────────────────────

/** "Save and continue": write bdc.yaml with this form, and let the project watch find it. */
function save(ctx, cx) {
  const form = formOf(ctx);
  const problem = formProblem(form);
  if (problem !== "" || ctx.state.saving === true) return;
  const root = folderNow();
  if (root === "") {
    ctx.setState({ error: "This space has no folder to set up." }, cx);
    return;
  }
  if (!Array.isArray(BDC) || BDC.length === 0) {
    ctx.setState({ error: "bdc is not installed for this checkout: run `bdc herdr install`" }, cx);
    return;
  }
  const args = initArgs(root, JSON.stringify(configFromForm(form)));
  ctx.setState({ saving: true, error: "" }, cx);
  cx.spawn(async (asyncCx) => {
    let error = "";
    try {
      const result = await host.exec(BDC[0], [...BDC.slice(1), ...args]);
      if (result.code !== 0) error = String(result.stderr ?? "").trim() || `bdc init exited with code ${result.code}`;
    } catch (thrown) {
      error = message(thrown);
    }
    ctx.setState({ saving: false, error }, asyncCx);
  });
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
