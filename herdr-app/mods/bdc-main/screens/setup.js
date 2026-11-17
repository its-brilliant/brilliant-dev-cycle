// Setup (spec §9.3 "New project", frame 11b): the space has no bdc.yaml, so there is no project
// for bdc to run in yet. This is a stub: worker 2 fills in picking a repo and creating the
// project here. Until then it says what is missing and what a bdc.yaml is.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

export function render(_view, ctx) {
  const t = ctx.t;
  return v_flex()
    .id("bdc-setup")
    .gap(12)
    .child(div().text_size(20).font_semibold().child("Set up this project"))
    .child(t.label("bdc works in a folder that has a bdc.yaml. The space you are in does not have one, so there is nothing to run yet."))
    .child(
      t.card(
        t.section("What to do"),
        t.label("Select a space whose folder already has a bdc.yaml — the sidebar lists them — or add one to this project and pick it again."),
        h_flex().gap(8).child(t.button("Read the spec", { id: "bdc-setup-spec", disabled: true, reason: "Opening the spec needs the project screen, which comes next" })),
      ),
    )
    .child(t.label("Coming next: choosing a repo and creating the project from here, with the roles and models for its agents.", { color: t.colors.dim, size: t.type.small }));
}
