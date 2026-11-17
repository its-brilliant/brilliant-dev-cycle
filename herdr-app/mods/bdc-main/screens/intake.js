// Intake (spec §4.1, §9.3 "Goal"): the PM grills the person in PM chat; this screen shows the goal,
// whether the PM is waiting on them, and what is settled so far. Before the brief exists, the
// settled answers come from the chat, where each round the person answered is one "you" entry of
// "question → answer" pairs (src/machines/run.ts, answersInWords).
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";

export function render(view, ctx) {
  const t = ctx.t;
  const brief = view?.brief ?? null;
  const settled = brief !== null ? brief.decisions : answersFromChat(view?.chat ?? []);
  const asking = view?.asking ?? null;
  return v_flex()
    .id("bdc-intake")
    .gap(12)
    .child(div().text_size(20).font_semibold().child("Getting the goal straight"))
    .child(t.card(t.section("The goal"), t.label(view?.goal ?? "")))
    .child(
      asking !== null
        ? t.card(
            t.label(
              `The PM is asking you ${asking.questions.length === 1 ? "a question" : `${asking.questions.length} questions`} in PM chat.`,
            ),
            t.label("Answer there, one at a time. Accepting the recommended answer is Enter.", { color: t.colors.dim, size: t.type.small }),
          )
        : t.label(settled.length === 0 ? "The PM is reading the repo…" : "The PM is working with your answers…", { color: t.colors.muted }),
    )
    .when(settled.length > 0, (column) =>
      column.child(t.card(t.section("Settled so far"), ...settled.map((item) => decisionRow(t, item.question, item.answer)))),
    )
    .when(brief !== null && brief.assumptions.length > 0, (column) =>
      column.child(t.card(t.section("Assumed"), ...brief.assumptions.map((assumption) => t.label(`• ${assumption}`, { color: t.colors.muted, size: t.type.small })))),
    );
}

/** Every "question → answer" the person gave in PM chat, oldest first. */
export function answersFromChat(chat) {
  const settled = [];
  for (const entry of chat) {
    if (entry.from !== "you") continue;
    for (const pair of entry.text.split("; ")) {
      const at = pair.indexOf(" → ");
      if (at > 0) settled.push({ question: pair.slice(0, at), answer: pair.slice(at + 3) });
    }
  }
  return settled;
}

function decisionRow(t, question, answer) {
  return v_flex()
    .gap(2)
    .child(div().text_size(t.type.small).text_color(t.colors.dim).child(question))
    .child(div().text_size(t.type.ui).text_color(t.colors.fg).child(answer));
}
