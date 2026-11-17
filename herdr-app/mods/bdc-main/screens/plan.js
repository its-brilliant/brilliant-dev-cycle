// Plan (spec §4.3, §9.3 "Plan", frame 02): the phase DAG, one phase's tasks and checks in an
// inspector beside it, Approve plan or Request changes.
//
// The graph is drawn from plan-dag.js, which answers where each card sits (columns are dependency
// depths, so a phase is always right of what it waits on) and how each edge runs between them as
// 1px rectangles. Cards and edges are absolutely placed inside a canvas of the size that layout
// reports, so 1 to 12 phases both work and the canvas scrolls when it is bigger than the pane.
//
// A comment is one person event per phase (§5.6 PLAN_COMMENT); what was said is kept here as well,
// because the run's view carries the plan but not its comments.
import { div } from "gpui-kit";
import { Input, h_flex, v_flex } from "gpui-base";
import { plural } from "../kit/words.js";
import { checkWords, countWords, dagLayout, dependants, proofKinds } from "./plan-dag.js";

export function render(view, ctx) {
  const t = ctx.t;
  const plan = view?.plan ?? null;
  const phases = plan?.phases ?? [];
  const planning = view?.stage === "planning";
  // Nothing to approve until there is a plan (§9.1 rule 3).
  const readOnly = ctx.readOnly === true || planning || plan === null;
  return v_flex()
    .id("bdc-plan")
    .flex_1()
    .min_h(0)
    .gap(10)
    .child(toolbar(t, ctx, { phases, planning, readOnly }))
    .when(ctx.state.error !== undefined && ctx.state.error !== "", (column) =>
      column.child(div().text_size(t.type.small).text_color(t.colors.blocked).child(ctx.state.error)),
    )
    .when(plan === null, (column) => column.child(writing(t, ctx)))
    .when(plan !== null, (column) => column.child(body(t, ctx, phases, readOnly)));
}

/** What the plan is, and the two things the stage waits for (§4.3). */
function toolbar(t, ctx, { phases, planning, readOnly }) {
  const said = Array.isArray(ctx.state.said) ? ctx.state.said : [];
  const row = h_flex()
    .flex_none()
    .gap(8)
    .items_center()
    .child(div().text_size(t.type.title).font_semibold().text_color(t.colors.fg).child("Plan"))
    .when(phases.length > 0, (bar) => bar.child(t.pill(plural(phases.length, "phase"), "accent")))
    .when(planning, (bar) => bar.child(t.pill("writing", "working")))
    .child(t.label(ctx.view?.stageWords ?? "Writing the plan", { color: t.colors.dim, size: t.type.small, wrap: false }))
    .child(div().flex_1());
  if (readOnly) {
    row.child(t.label(readOnlyWords({ phases, planning, readOnly: ctx.readOnly === true }), { color: t.colors.dim, size: t.type.small }));
    return row;
  }
  if (ctx.state.requesting === true) {
    const noteInput = ctx.inputs["plan.note"];
    const ready = said.length > 0 || String(ctx.state.note ?? "").trim() !== "";
    return v_flex()
      .gap(6)
      .child(row)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .when(noteInput !== undefined, (line) =>
            line.child(
              Input.new(noteInput)
                .w(340)
                .h(28)
                .px(8)
                .rounded(t.radii.input)
                .border(1)
                .border_color(t.colors.input)
                .bg(t.colors.bg)
                .text_size(t.type.ui)
                .text_color(t.colors.fg),
            ),
          )
          .child(
            t
              .button("Send request", { id: "bdc-plan-send-changes", primary: true, disabled: !ready, reason: "Comment on a phase, or type what to change" })
              .on_click((_event, cx) => sendChanges(ctx, cx)),
          )
          .child(t.button("Cancel", { id: "bdc-plan-changes-cancel" }).on_click((_event, cx) => closeRequest(ctx, cx)))
          .child(
            t.label(
              ready
                ? said.length > 0
                  ? `The planner gets this with ${plural(said.length, "comment")}.`
                  : "The planner gets this note."
                : "Comment on a phase, or type what to change.",
              { color: t.colors.dim, size: t.type.small },
            ),
          ),
      );
  }
  return row
    .child(t.button("Request changes", { id: "bdc-plan-request-changes" }).on_click((_event, cx) => openRequest(ctx, cx)))
    .child(t.button("Approve plan", { id: "bdc-plan-approve", primary: true }).on_click((_event, cx) => sendEvent(ctx, { type: "PLAN_APPROVED" }, cx)));
}

/** Why the two buttons are not here, in words (§9.1 rule 3). */
function readOnlyWords({ phases, planning, readOnly }) {
  if (planning) return "The planner has the pen.";
  if (phases.length === 0) return "There is no plan to review yet.";
  if (readOnly) return "The run has moved past the plan, so this is read-only.";
  return "The plan is read-only for now.";
}

/** No plan yet: what the planner is doing, in the run's own words (§9.1 rule 4). */
function writing(t, ctx) {
  return t.card(
    div().text_size(t.type.ui).text_color(t.colors.fg).child("Writing the plan…"),
    t.label(ctx.view?.stageWords ?? "The planner is reading the approved spec", { color: t.colors.muted }),
    t.label("The phases appear here as a graph as soon as the planner submits them. Then you check what each phase builds, comments on a phase, and approves.", {
      color: t.colors.dim,
      size: t.type.small,
    }),
  );
}

// ── the graph and the inspector ─────────────────────────────────────────────────────────────

function body(t, ctx, phases, readOnly) {
  const layout = dagLayout(phases);
  const selected = phases.find((phase) => phase.id === ctx.state.selected) ?? null;
  return h_flex()
    .flex_1()
    .min_h(0)
    .gap(10)
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .min_h(0)
        .gap(6)
        .when(layout.cyclic.length > 0, (column) =>
          column.child(
            div()
              .text_size(t.type.small)
              .text_color(t.colors.blocked)
              .child(`These phases wait on each other in a circle: ${layout.cyclic.join(", ")}. Ask for changes so the planner can break it.`),
          ),
        )
        .child(
          div()
            .id("bdc-plan-canvas")
            .flex_1()
            .min_h(0)
            .overflow_x_scrollbar()
            .overflow_y_scrollbar()
            .child(
              div()
                .relative()
                .w(layout.width)
                .h(layout.height)
                .children(layout.edges.flatMap((edge, edgeIndex) => edge.segments.map((segment, segmentIndex) => edgeLine(t, segment, edgeIndex, segmentIndex))))
                .children(layout.cards.map((card) => phaseCard(t, ctx, card))),
            ),
        ),
    )
    .when(selected !== null, (row) => row.child(inspector(t, ctx, phases, selected, readOnly)));
}

/** One 1px piece of an edge: the lines that say which phase waits on which. */
function edgeLine(t, segment, edgeIndex, segmentIndex) {
  return div()
    .id(`bdc-plan-edge-${edgeIndex}-${segmentIndex}`)
    .absolute()
    .left(segment.left)
    .top(segment.top)
    .w(segment.width)
    .h(segment.height)
    .bg(t.colors.input);
}

/** One phase: its id, what it builds, and how much of it there is. Clicking it opens the inspector. */
function phaseCard(t, ctx, card) {
  const phase = card.phase;
  const selected = ctx.state.selected === phase.id;
  return v_flex()
    .id(`bdc-plan-phase-${phase.id}`)
    .absolute()
    .left(card.x)
    .top(card.y)
    .w(card.width)
    .h(card.height)
    .gap(3)
    .p(8)
    .overflow_hidden()
    .rounded(9)
    .border(selected ? 1.5 : 1)
    .border_color(selected ? t.colors.accent : t.colors.input)
    .bg(selected ? t.colors.canvas : t.colors.bg)
    .cursor_pointer()
    .hover((style) => style.bg(t.colors.raised))
    .on_click((_event, cx) => selectPhase(ctx, phase.id, cx))
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(div().font_family(t.mono).text_size(t.type.tiny).text_color(t.colors.dim).child(phase.id))
        .child(div().flex_1())
        .when(phase.deps.length > 0, (row) => row.child(div().font_family(t.mono).text_size(t.type.tiny).text_color(t.colors.dim).child(`after ${phase.deps.join(", ")}`))),
    )
    .child(div().text_size(12.5).font_semibold().text_color(t.colors.fg).truncate().child(phase.title))
    .child(div().text_size(t.type.small).text_color(t.colors.muted).child(`${countWords(phase.tasks.length, "task")} · ${countWords(phase.checks.length, "check")}`))
    .child(
      h_flex()
        .gap(4)
        .flex_wrap()
        .children(proofKinds(phase).map((kind) => t.pill(kind, "dim"))),
    );
}

/** One phase in full: what it depends on, what it unlocks, its tasks, checks, proof and comments. */
function inspector(t, ctx, phases, phase) {
  const said = (Array.isArray(ctx.state.said) ? ctx.state.said : []).filter((entry) => entry.phaseId === phase.id);
  const rows = [
    h_flex()
      .gap(6)
      .items_center()
      .child(t.section("Phase"))
      .child(div().flex_1())
      .child(
        div()
          .id("bdc-plan-inspector-close")
          .cursor_pointer()
          .text_size(t.type.small)
          .text_color(t.colors.dim)
          .hover((style) => style.text_color(t.colors.fg))
          .child("Close")
          .on_click((_event, cx) => ctx.setState({ selected: "", commentFor: "", editing: false }, cx)),
      ),
    div().font_family(t.mono).text_size(t.type.small).text_color(t.colors.muted).child(phase.id),
    div().text_size(t.type.ui).text_color(t.colors.fg).child(phase.title),
    t.label(phase.deps.length === 0 ? "Starts first." : `Waits for ${phase.deps.join(", ")}.`, { color: t.colors.dim, size: t.type.small }),
  ];
  const unlocks = dependants(phases, phase.id);
  if (unlocks.length > 0) rows.push(t.label(`Unlocks ${unlocks.join(", ")}.`, { color: t.colors.dim, size: t.type.small }));
  rows.push(t.section("Tasks"));
  for (const task of phase.tasks) {
    rows.push(
      v_flex()
        .gap(1)
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(div().font_family(t.mono).text_size(t.type.tiny).text_color(t.colors.dim).child(task.id))
            .child(div().flex_1().text_size(t.type.ui).text_color(t.colors.fg).child(task.title)),
        )
        .when(task.paths.length > 0, (column) => column.child(div().font_family(t.mono).text_size(t.type.tiny).text_color(t.colors.dim).child(task.paths.join("  ")))),
    );
  }
  rows.push(t.section("Checks"));
  if (phase.checks.length === 0) rows.push(t.label("Only the repo's own checks run on this phase.", { color: t.colors.dim, size: t.type.small }));
  for (const check of phase.checks) rows.push(div().font_family(t.mono).text_size(t.type.small).text_color(t.colors.muted).child(checkWords(check)));
  rows.push(t.section("Proof"));
  for (const item of phase.proof) {
    rows.push(
      h_flex()
        .gap(6)
        .items_center()
        .child(t.pill(item.kind, "review"))
        .child(div().flex_1().text_size(t.type.small).text_color(t.colors.muted).child(item.shows === "" ? "no note on what it shows" : item.shows)),
    );
  }
  rows.push(...commentRows(t, ctx, phase, said));
  return v_flex()
    .id("bdc-plan-inspector")
    .w(360)
    .flex_none()
    .min_h(0)
    .gap(8)
    .p(10)
    .rounded(t.radii.card)
    .border(1)
    .border_color(t.colors.border)
    .bg(t.colors.bg)
    .overflow_y_scrollbar()
    .children(rows);
}

/** What the person said about this phase, and the way to say more (§4.3: comment on a phase). */
function commentRows(t, ctx, phase, said) {
  const rows = [t.section("Comments")];
  for (const entry of said) rows.push(div().text_size(t.type.small).text_color(t.colors.muted).child(entry.body));
  if (ctx.readOnly === true) return rows;
  if (ctx.state.commentFor !== phase.id) {
    rows.push(t.button("Comment on this phase", { id: "bdc-plan-comment" }).on_click((_event, cx) => openComment(ctx, phase, cx)));
    return rows;
  }
  const field = ctx.inputs["plan.comment"];
  if (field !== undefined) {
    rows.push(
      Input.new(field)
        .h(30)
        .px(8)
        .rounded(t.radii.input)
        .border(1)
        .border_color(t.colors.input)
        .bg(t.colors.canvas)
        .text_size(t.type.ui)
        .text_color(t.colors.fg),
    );
  }
  const typed = String(ctx.state.commentBody ?? "").trim() !== "";
  rows.push(
    h_flex()
      .gap(6)
      .items_center()
      .child(
        t
          .button("Add comment", { id: "bdc-plan-add-comment", primary: true, disabled: !typed, reason: "Type the comment first" })
          .on_click((_event, cx) => addComment(ctx, phase, cx)),
      )
      .child(t.button("Cancel", { id: "bdc-plan-comment-cancel" }).on_click((_event, cx) => closeComment(ctx, cx))),
  );
  return rows;
}

// ── handlers ────────────────────────────────────────────────────────────────────────────────

function selectPhase(ctx, phaseId, cx) {
  ctx.setState({ selected: ctx.state.selected === phaseId ? "" : phaseId, commentFor: "", editing: false }, cx);
}

/**
 * A text field's InputState, made here in the handler that opens the field: Herdr's rule is that
 * retained text state is created in a handler or init, never in render. `ctx.inputs` is this
 * view's own map of them.
 */
function fieldInput(ctx, name, value, cx) {
  const first = ctx.inputs[name] === undefined;
  const input = ctx.input(name, cx);
  if (first) input.set_value(value ?? "");
  return input;
}

function openComment(ctx, phase, cx) {
  const first = ctx.inputs["plan.comment"] === undefined;
  const field = fieldInput(ctx, "plan.comment", "", cx);
  if (first) field.on("change", (_event, inputCx) => ctx.setState({ commentBody: field.value() }, inputCx));
  ctx.setState({ commentFor: phase.id, commentBody: "", editing: true }, cx);
}

function closeComment(ctx, cx) {
  ctx.setState({ commentFor: "", commentBody: "", editing: false }, cx);
}

function addComment(ctx, phase, cx) {
  const body = String(ctx.state.commentBody ?? "").trim();
  if (body === "") return;
  const said = Array.isArray(ctx.state.said) ? ctx.state.said : [];
  sendEvent(ctx, { type: "PLAN_COMMENT", phaseId: phase.id, body }, cx);
  ctx.inputs["plan.comment"]?.set_value("");
  ctx.setState({ said: [...said, { phaseId: phase.id, body }], commentFor: "", commentBody: "", editing: false }, cx);
}

function openRequest(ctx, cx) {
  const first = ctx.inputs["plan.note"] === undefined;
  const note = fieldInput(ctx, "plan.note", "", cx);
  if (first) note.on("change", (_event, inputCx) => ctx.setState({ note: note.value() }, inputCx));
  ctx.setState({ requesting: true, editing: true }, cx);
}

function closeRequest(ctx, cx) {
  ctx.setState({ requesting: false, editing: false, note: "" }, cx);
}

function sendChanges(ctx, cx) {
  const note = String(ctx.state.note ?? "").trim();
  sendEvent(ctx, { type: "PLAN_CHANGES_REQUESTED", ...(note === "" ? {} : { note }) }, cx);
  ctx.inputs["plan.note"]?.set_value("");
  closeRequest(ctx, cx);
}

/** One person event through the router; a refusal is this screen's own error line (§9.1 rule 3). */
function sendEvent(ctx, event, cx) {
  cx.spawn(async (asyncCx) => {
    const outcome = await ctx.send(event);
    ctx.setState({ error: outcome.ok ? "" : outcome.error }, asyncCx);
  });
}
