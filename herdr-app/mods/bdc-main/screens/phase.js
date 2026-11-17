// Phase detail (spec §4.4, §9.3 "Phase detail", frame 04): one phase — the tasks it was planned
// with, what each review lens found, the verification steps with their output tail, the proof it
// came with, and what the PM said about it. It sends only the two events that work on a phase now
// (§5.6): RETRY on a stopped phase, and OVERRIDE of a lens that still blocks, with your reason.
import { div, image } from "gpui-kit";
import { Input, h_flex, v_flex } from "gpui-base";
import { plural } from "../kit/words.js";
import { attemptsWords } from "./build-board.js";
import {
  blockingLenses,
  decisionsAbout,
  depsWords,
  findingNote,
  proofRows,
  reviewByLens,
  tasksOf,
  verificationRows,
  verificationWords,
} from "./phase-detail.js";
import { fileLine, severityTone, statusTone, statusWords } from "./reviews-filters.js";

/** The InputStates whose change event this module wired; the typed reason lives in screen state. */
const wired = new WeakSet();

/** The reason input's name in the mod's InputStates (main.js owns them across renders). */
const REASON_INPUT = "phase-override";

export function render(view, ctx) {
  const t = ctx.t;
  const phase = (view?.phases ?? []).find((candidate) => candidate.id === ctx.state.phaseId) ?? null;
  if (phase === null) {
    return v_flex()
      .id("bdc-phase")
      .gap(10)
      .child(div().text_size(20).font_semibold().child("Phase"))
      .child(t.label("Pick a phase on the Build screen to see it here.", { color: t.colors.muted }));
  }
  const decisions = decisionsCard(t, view, phase);
  return v_flex()
    .id("bdc-phase")
    .flex_1()
    .min_h(0)
    .gap(12)
    .child(header(t, view, phase, ctx))
    .children(actions(t, phase, ctx))
    .child(
      h_flex()
        .flex_1()
        .min_h(0)
        .gap(12)
        .items_start()
        .overflow_y_scrollbar()
        .child(v_flex().flex_1().min_w(0).gap(12).child(tasksCard(t, view, phase)).child(verificationCard(t, phase, ctx)).child(proofCard(t, view, phase, ctx)))
        .child(v_flex().w(340).flex_none().gap(12).child(reviewCard(t, phase)).when(decisions !== null, (column) => column.child(decisions))),
    );
}

/** Title, what it is doing and where it sits in the plan; the way back to the board (§9.2). */
function header(t, view, phase, ctx) {
  const facts = [depsWords(phase, view.phases), attemptsWords(phase)].filter((fact) => fact !== "");
  return v_flex()
    .gap(6)
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(t.button("Back to the board", { id: "bdc-phase-back" }).on_click((_event, cx) => ctx.go("build", {}, cx)))
        .child(div().text_size(t.type.tiny).text_color(t.colors.dim).child(phase.id))
        .child(div().text_size(20).font_semibold().child(phase.title))
        .child(t.pill(phase.words, phase.needsYou ? "blocked" : phase.state === "done" ? "pass" : "working")),
    )
    .child(t.label(facts.join(" · "), { color: t.colors.dim, size: t.type.small }));
}

/** Retry a stopped phase, or override a lens that still blocks — the actions that work now. */
function actions(t, phase, ctx) {
  if (ctx.readOnly === true) return [];
  const rows = [];
  const sending = ctx.state.sending === true;
  const stopped = phase.state === "stopped" || phase.state === "cancelled";
  if (stopped) {
    rows.push(
      h_flex()
        .gap(8)
        .items_center()
        .child(t.button("Retry this phase", { id: "bdc-phase-retry", primary: true, disabled: sending }).on_click((_event, cx) => send(ctx, { type: "RETRY", phaseId: phase.id }, cx)))
        .child(t.label("Retry picks this phase up where it stopped; the phases that waited for it start again.", { color: t.colors.dim, size: t.type.small })),
    );
  }
  const lenses = blockingLenses(phase);
  const deciding = phase.state === "deciding" || phase.state === "awaitingYou";
  if (deciding && lenses.length > 0) rows.push(...overrideRows(t, phase, lenses, ctx, sending));
  if (sending) rows.push(t.label("Sending…", { color: t.colors.dim, size: t.type.small }));
  if (typeof ctx.state.error === "string" && ctx.state.error !== "") rows.push(div().text_size(t.type.small).text_color(t.colors.blocked).child(ctx.state.error));
  if (rows.length === 0) return [];
  return [v_flex().id("bdc-phase-actions").gap(8).children(rows)];
}

/** "Override security" per blocking lens, then the reason the person types (§6: it is recorded). */
function overrideRows(t, phase, lenses, ctx, sending) {
  const overriding = typeof ctx.state.overriding === "string" ? ctx.state.overriding : "";
  const input = ctx.inputs[REASON_INPUT];
  if (overriding === "" || input === undefined) {
    const buttons = lenses.map((lens) =>
      t.button(`Override ${lens}`, { id: `bdc-phase-override-${slug(lens)}`, disabled: sending }).on_click((_event, cx) => startOverride(ctx, lens, cx)),
    );
    return [h_flex().gap(8).items_center().child(t.label("A lens still blocks this phase. You can let it through yourself:", { color: t.colors.muted, size: t.type.small })).children(buttons)];
  }
  const typed = String(ctx.state.overrideText ?? "").trim();
  return [
    v_flex()
      .id("bdc-phase-override")
      .gap(6)
      .child(t.label(`Why are you overriding ${overriding}? It goes into the pull request as yours.`, { color: t.colors.muted, size: t.type.small }))
      .child(Input.new(input).h(34).px(9).rounded(t.radii.input).border(1).border_color(t.colors.input).bg(t.colors.bg).text_size(t.type.ui).text_color(t.colors.fg))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            t
              .button("Send the override", { id: "bdc-phase-override-send", primary: true, disabled: typed === "" || sending, reason: "Type why first" })
              .on_click((_event, cx) => sendOverride(ctx, phase, overriding, cx)),
          )
          .child(t.button("Cancel", { id: "bdc-phase-override-cancel" }).on_click((_event, cx) => ctx.setState({ overriding: "", overrideText: "" }, cx))),
      ),
  ];
}

function startOverride(ctx, lens, cx) {
  const input = ctx.input("phase-override", cx);
  if (!wired.has(input)) {
    wired.add(input);
    input.on("change", (_event, inputCx) => ctx.setState({ overrideText: input.value() }, inputCx));
  }
  input.set_value("");
  ctx.setState({ overriding: lens, overrideText: "", error: "" }, cx);
}

/** The plan's tasks, which is what the phase was built from (§4.3). */
function tasksCard(t, view, phase) {
  const tasks = tasksOf(view, phase.id);
  const rows = tasks.map((task) =>
    h_flex()
      .id(`bdc-task-${slug(task.id)}`)
      .gap(8)
      .items_start()
      .child(div().w(58).text_size(t.type.tiny).text_color(t.colors.dim).child(task.id))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().text_size(t.type.ui).text_color(t.colors.fg).child(task.title))
          .when(task.paths.length > 0, (column) => column.child(t.label(task.paths.join(", "), { color: t.colors.dim, size: t.type.small }))),
      ),
  );
  return t.card(
    t.section(`Tasks · ${plural(tasks.length, "task")}`),
    t.label("Each task has a builder of its own in its own worktree. The run does not name the builder in this view yet.", { color: t.colors.dim, size: t.type.small }),
    ...(rows.length === 0 ? [t.label("The plan named no tasks for this phase.", { color: t.colors.muted })] : rows),
  );
}

/** One reviewer per lens, its findings and what happened to each (§8.1). */
function reviewCard(t, phase) {
  const lenses = reviewByLens(phase);
  if (lenses.length === 0) return t.card(t.section("Review"), t.label("No lens has reported on this phase yet.", { color: t.colors.muted }));
  const rows = [];
  for (const lens of lenses) {
    rows.push(
      h_flex()
        .id(`bdc-lens-${slug(lens.lens)}`)
        .gap(8)
        .items_center()
        .child(div().flex_1().text_size(t.type.small).text_color(t.colors.muted).child(lens.lens))
        .child(t.pill(lens.words, lens.tone)),
    );
    for (const finding of lens.findings) rows.push(findingRow(t, finding));
  }
  return t.card(t.section(`Review · ${plural(phase.findings.length, "finding")}`), ...rows);
}

function findingRow(t, finding) {
  const place = fileLine(finding);
  const note = findingNote(finding);
  return v_flex()
    .id(`bdc-finding-${slug(finding.id)}`)
    .gap(3)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(t.pill(finding.severity, severityTone(finding.severity)))
        .child(div().flex_1().text_size(t.type.ui).text_color(t.colors.fg).child(finding.summary))
        .child(t.pill(statusWords(finding.status), statusTone(finding.status))),
    )
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .when(place !== "", (row) => row.child(div().text_size(t.type.tiny).font_family(t.mono).text_color(t.colors.dim).child(place)))
        .when(note !== "", (row) => row.child(div().flex_1().text_size(t.type.tiny).text_color(t.colors.dim).child(note))),
    );
}

/** Every verification step with its command, duration and output tail, opened one at a time. */
function verificationCard(t, phase, ctx) {
  const steps = verificationRows(phase);
  if (steps.length === 0) return t.card(t.section("Verification"), t.label("This phase has not been verified yet.", { color: t.colors.muted }));
  const open = Array.isArray(ctx.state.expanded) ? ctx.state.expanded : [];
  const rows = steps.map((step) => {
    const isOpen = open.includes(step.key);
    return v_flex()
      .id(`bdc-check-${slug(step.key)}`)
      .gap(4)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .rounded(4)
          .hover((style) => style.bg(t.colors.raised))
          .on_click((_event, cx) => ctx.setState({ expanded: toggle(open, step.key) }, cx))
          .child(t.pill(step.words, step.tone))
          .child(div().flex_1().text_size(t.type.small).text_color(t.colors.muted).child(step.name))
          .child(div().text_size(t.type.tiny).font_family(t.mono).text_color(t.colors.dim).child(step.command))
          .child(div().text_size(t.type.tiny).text_color(t.colors.dim).child(step.duration))
          .when(step.outputTail !== "", (row) => row.child(div().text_size(t.type.tiny).text_color(t.colors.accent).child(isOpen ? "hide output" : "show output"))),
      )
      .when(isOpen && step.outputTail !== "", (column) =>
        column.child(div().p(8).rounded(6).bg(t.colors.canvas).text_size(t.type.tiny).font_family(t.mono).text_color(t.colors.muted).child(step.outputTail)),
      );
  });
  return t.card(t.section("Verification"), t.label(verificationWords(phase), { color: t.colors.muted, size: t.type.small }), ...rows);
}

/** Each proof item, who made it, and a thumbnail for a screenshot (§4.4.1). */
function proofCard(t, view, phase, ctx) {
  const items = proofRows(view, phase, ctx.root);
  if (items.length === 0) return t.card(t.section("Proof"), t.label("This phase has no proof yet.", { color: t.colors.muted }));
  const rows = items.map((item) =>
    v_flex()
      .id(`bdc-proof-${slug(item.key)}`)
      .gap(6)
      .child(
        h_flex()
          .gap(8)
          .items_start()
          .child(t.pill(item.kind, "review"))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(2)
              .child(div().text_size(t.type.ui).text_color(t.colors.fg).child(item.shows))
              .child(t.label(item.file === "" ? item.by : `${item.by} · ${item.file}`, { color: t.colors.dim, size: t.type.small })),
          ),
      )
      .when(item.image !== "", (column) => column.child(image(item.image).w(240).h(150).rounded(6))),
  );
  return t.card(t.section("Proof"), ...rows);
}

/** What the PM said about this phase, from the run's chat (§4.4, §6). */
function decisionsCard(t, view, phase) {
  const said = decisionsAbout(view, phase);
  if (said.length === 0) return null;
  return t.card(
    t.section("What the PM said"),
    ...said.map((entry) =>
      v_flex()
        .gap(2)
        .child(div().text_size(t.type.tiny).text_color(t.colors.dim).child("PM"))
        .child(div().text_size(t.type.small).text_color(t.colors.muted).child(entry.text)),
    ),
  );
}

/** One person event through `bdc send`; a refusal is shown inline, never thrown (§9.1 rule 3). */
function send(ctx, event, cx) {
  ctx.setState({ sending: true, error: "" }, cx);
  cx.spawn(async (asyncCx) => {
    const outcome = await ctx.send(event);
    ctx.setState({ sending: false, error: outcome.ok ? "" : outcome.error }, asyncCx);
  });
}

function sendOverride(ctx, phase, lens, cx) {
  const reason = String(ctx.state.overrideText ?? "").trim();
  if (reason === "") return;
  ctx.setState({ sending: true, error: "" }, cx);
  cx.spawn(async (asyncCx) => {
    const outcome = await ctx.send({ type: "OVERRIDE", phaseId: phase.id, lens, reason });
    ctx.inputs[REASON_INPUT]?.set_value("");
    ctx.setState(outcome.ok ? { overriding: "", overrideText: "", sending: false, error: "" } : { sending: false, error: outcome.error }, asyncCx);
  });
}

/** A list with `key` added or removed, for the steps whose output is open. */
function toggle(list, key) {
  return list.includes(key) ? list.filter((item) => item !== key) : [...list, key];
}

/** An element id from a value the run chose, so two findings cannot share one. */
function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}
