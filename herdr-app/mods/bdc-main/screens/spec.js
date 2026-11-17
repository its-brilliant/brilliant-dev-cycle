// Spec (spec §4.2, §9.3 "Spec", frame 01): read the rendered spec, select text to comment,
// Approve spec. A stub: it says which version is on screen and what the comments say, which is
// already the useful part of the review. Worker 2 fills in the rendered markdown and the
// select-to-comment column.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";

export function render(view, ctx) {
  const t = ctx.t;
  const spec = view?.spec ?? null;
  const open = spec === null ? 0 : spec.comments.filter((comment) => !comment.resolved).length;
  const comments =
    spec === null
      ? []
      : spec.comments.map((comment) =>
          v_flex()
            .gap(2)
            .child(div().text_size(t.type.small).text_color(t.colors.dim).child(comment.resolved ? "resolved" : "open"))
            .child(div().text_size(t.type.small).text_color(t.colors.muted).child(`“${comment.quote}”`))
            .child(div().text_size(t.type.ui).text_color(t.colors.fg).child(comment.body)),
        );
  return v_flex()
    .id("bdc-spec")
    .gap(12)
    .child(div().text_size(20).font_semibold().child("Spec"))
    .child(t.label(view?.stageWords ?? "Writing the spec…", { color: t.colors.muted }))
    .when(spec !== null, (column) =>
      column.child(
        t.card(
          t.section(`Version ${spec.version}`),
          t.label(open === 0 ? "No open comments." : `${open} open comment${open === 1 ? "" : "s"} to settle.`, { color: t.colors.muted }),
        ),
      ),
    )
    .when(comments.length > 0, (column) => column.child(t.card(t.section("Comments"), ...comments)))
    .when(spec === null, (column) => column.child(t.card(t.label("The spec writer is working. The draft appears here when it submits."))))
    .child(t.label("Coming next: the spec rendered as markdown, select text to comment, and Approve spec / Request changes.", { color: t.colors.dim, size: t.type.small }));
}
