// Intake (spec §4.1, §9.3 "Goal"): the PM's grilling rounds happen in PM chat, and this screen
// shows what is settled so far. A stub: it already shows the brief's decisions and assumptions,
// which grow as the person answers.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";

export function render(view, ctx) {
  const t = ctx.t;
  const brief = view?.brief ?? null;
  const settled = brief === null ? [] : brief.decisions.map((decision) => decisionRow(t, decision.question, decision.answer));
  const assumed = brief === null ? [] : brief.assumptions.map((assumption) => t.label(`• ${assumption}`, { color: t.colors.muted, size: t.type.small }));
  return v_flex()
    .id("bdc-intake")
    .gap(12)
    .child(div().text_size(20).font_semibold().child("Getting the goal straight"))
    .child(t.label(view?.stageWords ?? "The PM is reading the repo…", { color: t.colors.muted }))
    .when(brief !== null && settled.length > 0, (column) => column.child(t.card(t.section("Settled so far"), ...settled)))
    .when(brief !== null && assumed.length > 0, (column) => column.child(t.card(t.section("Assumed"), ...assumed)))
    .when(brief === null, (column) =>
      column.child(
        t.card(
          t.label("The PM reads the repo and then asks you questions, one at a time, in PM chat. Answer there; this list fills in as you go."),
          t.label("If the PM needs nothing from you, the spec starts on its own.", { color: t.colors.dim, size: t.type.small }),
        ),
      ),
    )
    .child(t.label("Coming next: the goal screen's brief, the decisions settled so far and the way to confirm the shared understanding.", { color: t.colors.dim, size: t.type.small }));
}

function decisionRow(t, question, answer) {
  return v_flex()
    .gap(2)
    .child(div().text_size(t.type.small).text_color(t.colors.dim).child(question))
    .child(div().text_size(t.type.ui).text_color(t.colors.fg).child(answer));
}
