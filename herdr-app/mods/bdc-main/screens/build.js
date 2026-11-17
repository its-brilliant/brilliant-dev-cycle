// Build (spec §4.4, §9.3 "Build (Progress)", frame 03): the phases as a board in dependency order,
// each with where it is on its five steps, what its review found and how its checks went. Clicking
// a phase opens its detail; what needs the person is in PM chat, so the board only says which
// phase it is about (§9.4).
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { attemptsWords, checksWords, findingsWords, needsYouWords, phaseWaves, phasesDone, PHASE_STEPS, stepTrack } from "./build-board.js";

/** The color each step of a phase's track takes: behind it, on it, waiting its turn, ahead. */
const STEP_COLORS = { done: "pass", active: "accent", queued: "working", waiting: "input" };

export function render(view, ctx) {
  const t = ctx.t;
  const phases = view?.phases ?? [];
  const done = phasesDone(phases);
  const asking = needsYouWords(phases);
  return v_flex()
    .id("bdc-build")
    .flex_1()
    .min_h(0)
    .gap(12)
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(div().text_size(20).font_semibold().child("Build"))
        .child(t.label(view?.stageWords ?? "Building", { color: t.colors.muted }))
        .child(div().flex_1())
        .child(t.label(done.words, { color: t.colors.dim, size: t.type.small })),
    )
    .when(asking !== "", (column) =>
      column.child(
        t.card(
          h_flex()
            .gap(8)
            .items_center()
            .child(t.pill("needs you", "blocked"))
            .child(t.label(asking, { color: t.colors.fg })),
        ),
      ),
    )
    .when(phases.length === 0, (column) =>
      column.child(t.card(t.label("No phases yet. The plan comes first, and the board fills in when the build starts.", { color: t.colors.muted }))),
    )
    .when(phases.length > 0, (column) => column.child(board(t, phases, ctx)))
    .when(phases.length > 0, (column) =>
      column.child(t.label(`Each card's track is ${PHASE_STEPS.join(" · ").toLowerCase()}, left to right. Click a phase to open it.`, { color: t.colors.dim, size: t.type.small })),
    );
}

/** The phases as columns of the dependency graph: what starts together stands together (§4.3). */
function board(t, phases, ctx) {
  return h_flex()
    .id("bdc-build-board")
    .flex_1()
    .min_h(0)
    .gap(10)
    .items_start()
    .overflow_scrollbar()
    .children(phaseWaves(phases).map((wave, index) => v_flex().id(`bdc-wave-${index}`).w(214).gap(8).children(wave.map((phase) => card(t, phase, ctx)))));
}

function card(t, phase, ctx) {
  const facts = [attemptsWords(phase), findingsWords(phase.findings), checksWords(phase)].filter((fact) => fact !== "");
  return v_flex()
    .id(`bdc-phase-${phase.id}`)
    .gap(7)
    .p(10)
    .rounded(t.radii.panel)
    .border(1)
    .border_color(phase.needsYou ? t.colors.blocked : phase.state === "done" ? t.colors.pass : t.colors.border)
    .bg(t.colors.bg)
    .cursor_pointer()
    .hover((style) => style.bg(t.colors.raised))
    .on_click((_event, cx) => ctx.go("phase", { phaseId: phase.id }, cx))
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(div().text_size(t.type.tiny).text_color(t.colors.dim).child(phase.id))
        .child(div().flex_1())
        .when(phase.needsYou, (row) => row.child(t.pill("needs you", "blocked"))),
    )
    .child(div().text_size(t.type.ui).text_color(t.colors.fg).child(phase.title))
    .child(div().text_size(t.type.small).text_color(phase.needsYou ? t.colors.blocked : t.colors.muted).child(phase.words))
    .child(track(t, phase))
    .when(facts.length > 0, (column) => column.child(t.label(facts.join(" · "), { color: t.colors.dim, size: t.type.small })))
    .when(phase.deps.length > 0, (column) => column.child(t.label(`needs ${phase.deps.join(", ")}`, { color: t.colors.dim, size: t.type.small })));
}

/** Build · merge · review · verify · proof, each segment saying what that step is doing. */
function track(t, phase) {
  return h_flex()
    .id(`bdc-track-${phase.id}`)
    .gap(3)
    .children(
      stepTrack(phase).map((step) =>
        div()
          .flex_1()
          .h(4)
          .rounded(2)
          .bg(t.colors[STEP_COLORS[step.status] ?? "input"])
          .tooltip(`${step.name}: ${stepWords(step.status)}`),
      ),
    );
}

/** What a segment means, in the tooltip a person reads (§9.1 rule 4). */
function stepWords(status) {
  switch (status) {
    case "done":
      return "done";
    case "active":
      return "happening now";
    case "queued":
      return "waiting its turn";
    default:
      return "not yet";
  }
}
