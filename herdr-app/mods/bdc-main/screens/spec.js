// Spec (spec §4.2, §9.3 "Spec", frame 01): read the spec as markdown, select words to comment on,
// settle the comments, approve or request changes.
//
// The spec arrives rendered-ready (`view.spec.markdown`) and is split into blocks by spec-blocks.js
// so each block can be hovered and commented on. gpui-kit's markdown view cannot report a
// selection, which §4.2 allows for: a block's Comment button turns that block into a read-only
// editor holding the same text, the person selects the words there, and the selection becomes the
// comment's quote (nothing selected means the whole block). Commented quotes are drawn with a
// background by splitting the block around them (spec-blocks.js `highlightSegments`).
//
// Everything here is one person event (§5.6): SPEC_COMMENT, SPEC_COMMENT_RESOLVED,
// SPEC_APPROVED, SPEC_CHANGES_REQUESTED. A failure is shown inline, never thrown (§9.1 rule 3).
import { div } from "gpui-kit";
import { Editor, EditorState, Input, TextView, h_flex, v_flex } from "gpui-base";
import { plural } from "../kit/words.js";
import { commentThreads, highlightSegments, nextCommentId, openCount, quoteAnchor, splitBlocks } from "./spec-blocks.js";

export function render(view, ctx) {
  const t = ctx.t;
  const spec = view?.spec ?? null;
  const comments = spec?.comments ?? [];
  const drafting = view?.stage === "specDrafting";
  // Nothing to approve or comment on until the first draft is here (§9.1 rule 3).
  const readOnly = ctx.readOnly === true || drafting || spec === null;
  return v_flex()
    .id("bdc-spec")
    .flex_1()
    .min_h(0)
    .gap(10)
    .child(toolbar(t, ctx, { spec, comments, drafting, readOnly }))
    .when(ctx.state.error !== undefined && ctx.state.error !== "", (column) =>
      column.child(div().text_size(t.type.small).text_color(t.colors.blocked).child(ctx.state.error)),
    )
    .when(spec === null, (column) => column.child(writing(t, ctx)))
    .when(spec !== null, (column) =>
      column.child(
        h_flex()
          .flex_1()
          .min_h(0)
          .gap(12)
          .child(documentColumn(t, ctx, spec, comments, readOnly))
          .child(commentColumn(t, ctx, comments, readOnly)),
      ),
    );
}

/** Version, what the run is doing, and the two buttons the stage is waiting for (§4.2). */
function toolbar(t, ctx, { spec, comments, drafting, readOnly }) {
  const open = openCount(comments);
  const row = h_flex()
    .flex_none()
    .gap(8)
    .items_center()
    .child(div().text_size(t.type.title).font_semibold().text_color(t.colors.fg).child("Spec"))
    .when(spec !== null, (bar) => bar.child(t.pill(`v${spec.version}`, "accent")))
    .when(drafting, (bar) => bar.child(t.pill("writing", "working")))
    .child(t.label(ctx.view?.stageWords ?? "Writing the spec", { color: t.colors.dim, size: t.type.small, wrap: false }))
    .child(div().flex_1());
  if (readOnly) {
    row.child(t.label(readOnlyWords({ spec, drafting, readOnly: ctx.readOnly === true }), { color: t.colors.dim, size: t.type.small }));
    return row;
  }
  if (ctx.state.requesting === true) {
    const noteInput = ctx.inputs["spec.note"];
    const ready = open > 0 || String(ctx.state.note ?? "").trim() !== "";
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
              .button("Send request", {
                id: "bdc-spec-send-changes",
                primary: true,
                disabled: !ready,
                reason: "Type what to change, or leave a comment on the spec",
              })
              .on_click((_event, cx) => sendChanges(ctx, cx)),
          )
          .child(t.button("Cancel", { id: "bdc-spec-changes-cancel" }).on_click((_event, cx) => closeRequest(ctx, cx)))
          .child(
            t.label(
              ready ? "The spec writer gets this note and every open comment." : "Type what to change, or leave a comment on the spec.",
              { color: t.colors.dim, size: t.type.small },
            ),
          ),
      );
  }
  return row
    .child(t.button("Request changes", { id: "bdc-spec-request-changes" }).on_click((_event, cx) => openRequest(ctx, cx)))
    .child(t.button("Approve spec", { id: "bdc-spec-approve", primary: true }).on_click((_event, cx) => sendEvent(ctx, { type: "SPEC_APPROVED" }, cx)));
}

/** Why the two buttons are not here, in words (§9.1 rule 3). */
function readOnlyWords({ spec, drafting, readOnly }) {
  if (drafting) return "The spec writer has the pen.";
  if (spec === null) return "There is no draft to review yet.";
  if (readOnly) return "The run has moved past the spec, so this is read-only.";
  return "The spec is read-only for now.";
}

/** No spec yet: what the spec writer is doing, in the run's own words (§9.1 rule 4). */
function writing(t, ctx) {
  return t.card(
    div().text_size(t.type.ui).text_color(t.colors.fg).child("Writing the spec…"),
    t.label(ctx.view?.stageWords ?? "The spec writer is reading the brief", { color: t.colors.muted }),
    t.label("The draft appears here as markdown as soon as the spec writer submits it. Then you read it, comment on the words you want changed, and approve.", {
      color: t.colors.dim,
      size: t.type.small,
    }),
  );
}

// ── the document ─────────────────────────────────────────────────────────────────────────────

function documentColumn(t, ctx, spec, comments, readOnly) {
  const blocks = splitBlocks(spec.markdown);
  return v_flex()
    .id("bdc-spec-document")
    .flex_1()
    .min_w(0)
    .min_h(0)
    .gap(2)
    .pr(6)
    .overflow_y_scrollbar()
    .children(blocks.map((block) => blockRow(t, ctx, block, comments, readOnly)));
}

/** One block: its markdown, a Comment button on hover, or the comment editor while it is open. */
function blockRow(t, ctx, block, comments, readOnly) {
  if (ctx.state.commentBlock === block.id) return commentEditor(t, ctx, block);
  const hovered = ctx.state.hover === block.id;
  const segments = highlightSegments(block.text, comments);
  return h_flex()
    .id(`bdc-spec-block-${block.id}`)
    .gap(8)
    .items_start()
    .rounded(4)
    .hover((style) => style.bg(t.colors.canvas))
    .when(!readOnly, (row) =>
      row.on_hover((inside, cx) => {
        if (inside) ctx.setState({ hover: block.id }, cx);
        else if (ctx.state.hover === block.id) ctx.setState({ hover: "" }, cx);
      }),
    )
    .child(div().flex_1().min_w(0).children(blockParts(t, block, segments)))
    .when(hovered && !readOnly, (row) =>
      row.child(t.button("Comment", { id: `bdc-spec-comment-${block.id}` }).on_click((_event, cx) => openComment(ctx, block, cx))),
    );
}

/** The block's text, split around the quotes its comments anchor to so each quote gets a background. */
function blockParts(t, block, segments) {
  const parts = segments.filter((segment) => segment.text !== "");
  if (parts.length <= 1) return [TextView.markdown(`bdc-spec-${block.id}`, block.text)];
  return parts.map((segment, index) =>
    segment.commentId === null
      ? TextView.markdown(`bdc-spec-${block.id}-${index}`, segment.text)
      : div()
          .id(`bdc-spec-quote-${block.id}-${index}`)
          .rounded(3)
          .px(3)
          .bg(tint(t.colors.working, "2e"))
          .child(div().text_size(13).text_color(t.colors.fg).child(segment.text)),
  );
}

/** The block as a read-only editor: the person selects the exact words there, and types the comment. */
function commentEditor(t, ctx, block) {
  const editor = ctx.inputs["spec.block"];
  const body = ctx.inputs["spec.body"];
  const typed = String(ctx.state.body ?? "").trim() !== "";
  return v_flex()
    .gap(6)
    .p(8)
    .rounded(t.radii.chip)
    .border(1)
    .border_color(t.colors.accent)
    .bg(t.colors.canvas)
    .child(t.label("Select the words to comment on, then say what to change. Nothing selected means the whole block.", { color: t.colors.muted, size: t.type.small }))
    .when(editor !== undefined, (column) =>
      column.child(
        Editor.new(editor)
          .h(Math.min(240, 30 + 18 * block.text.split("\n").length))
          .rounded(t.radii.input)
          .border(1)
          .border_color(t.colors.input)
          .bg(t.colors.bg),
      ),
    )
    .when(body !== undefined, (column) =>
      column.child(
        Input.new(body)
          .h(30)
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
      h_flex()
        .gap(6)
        .items_center()
        .child(
          t
            .button("Add comment", { id: "bdc-spec-add-comment", primary: true, disabled: !typed, reason: "Type the comment first" })
            .on_click((_event, cx) => addComment(ctx, cx)),
        )
        .child(t.button("Cancel", { id: "bdc-spec-comment-cancel" }).on_click((_event, cx) => closeComment(ctx, cx)))
        .when(!typed, (row) => row.child(t.label("Type the comment, then Add comment.", { color: t.colors.dim, size: t.type.small }))),
    );
}

// ── the comments ────────────────────────────────────────────────────────────────────────────

function commentColumn(t, ctx, comments, readOnly) {
  const threads = commentThreads(comments);
  const open = openCount(comments);
  return v_flex()
    .id("bdc-spec-comments")
    .w(330)
    .flex_none()
    .min_h(0)
    .gap(8)
    .overflow_y_scrollbar()
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(t.section("Comments"))
        .child(t.label(plural(threads.length, "comment"), { color: t.colors.dim, size: t.type.small, wrap: false }))
        .child(div().flex_1())
        .when(open > 0, (row) => row.child(t.pill(`${open} open`, "working"))),
    )
    .when(threads.length === 0, (column) => column.child(t.label("No comments yet. Hover a line of the spec and press Comment.", { color: t.colors.dim, size: t.type.small })))
    .children(threads.map((thread) => threadCard(t, ctx, thread, readOnly)));
}

function threadCard(t, ctx, thread, readOnly) {
  const comment = thread.comment;
  const resolved = comment.resolved === true;
  const replying = ctx.state.replyTo === comment.id;
  const replyInput = ctx.inputs["spec.reply"];
  const rows = [
    h_flex()
      .gap(6)
      .items_center()
      .child(t.pill(resolved ? "resolved" : "open", resolved ? "pass" : "working"))
      .child(div().flex_1())
      .when(!resolved && !readOnly, (row) =>
        row.child(t.button("Resolve", { id: `bdc-spec-resolve-${comment.id}` }).on_click((_event, cx) => sendEvent(ctx, { type: "SPEC_COMMENT_RESOLVED", commentId: comment.id }, cx))),
      ),
    div().text_size(t.type.small).text_color(t.colors.dim).child(`“${comment.quote}”`),
    div().text_size(t.type.ui).text_color(t.colors.fg).child(comment.body),
    ...thread.replies.map((reply) => div().pl(8).text_size(t.type.ui).text_color(t.colors.muted).child(reply.body)),
  ];
  if (!resolved && !readOnly) {
    if (replying && replyInput !== undefined) {
      rows.push(
        Input.new(replyInput)
          .h(28)
          .px(8)
          .rounded(t.radii.input)
          .border(1)
          .border_color(t.colors.input)
          .bg(t.colors.bg)
          .text_size(t.type.ui)
          .text_color(t.colors.fg),
      );
      const ready = String(ctx.state.reply ?? "").trim() !== "";
      rows.push(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            t
              .button("Send reply", { id: `bdc-spec-reply-send-${comment.id}`, primary: true, disabled: !ready, reason: "Type the reply first" })
              .on_click((_event, cx) => sendReply(ctx, comment, cx)),
          )
          .child(t.button("Cancel", { id: `bdc-spec-reply-cancel-${comment.id}` }).on_click((_event, cx) => closeReply(ctx, cx))),
      );
    } else {
      rows.push(t.button("Reply", { id: `bdc-spec-reply-${comment.id}` }).on_click((_event, cx) => openReply(ctx, comment, cx)));
    }
  }
  return v_flex()
    .id(`bdc-spec-thread-${comment.id}`)
    .gap(6)
    .p(8)
    .rounded(t.radii.chip)
    .border(1)
    .border_color(resolved ? t.colors.border : t.colors.input)
    .bg(t.colors.canvas)
    .children(rows);
}

// ── handlers ────────────────────────────────────────────────────────────────────────────────

/**
 * A text field's InputState, made here in the handler that opens the field: Herdr's rule is that
 * retained text state is created in a handler or init, never in render. `ctx.inputs` is this
 * view's own map of them, so opening the same field twice finds the same state.
 */
function fieldInput(ctx, name, value, cx) {
  const first = ctx.inputs[name] === undefined;
  const input = ctx.input(name, cx);
  if (first) input.set_value(value ?? "");
  return input;
}

function openComment(ctx, block, cx) {
  // A read-only editor holds the block's text, so the person can select the exact words. It is
  // kept in this view's own state map, beside the inputs, because it is the same kind of retained
  // state: made in a handler, read by render.
  ctx.inputs["spec.block"] = EditorState.new({ value: block.text, readonly: true, line_numbers: false, folding: false, soft_wrap: true, font_size: 13 });
  const first = ctx.inputs["spec.body"] === undefined;
  const body = fieldInput(ctx, "spec.body", "", cx);
  if (first) body.on("change", (_event, inputCx) => ctx.setState({ body: body.value() }, inputCx));
  ctx.setState({ editing: true, commentBlock: block.id, body: "" }, cx);
}

function closeComment(ctx, cx) {
  ctx.setState({ editing: false, commentBlock: "", body: "", hover: "" }, cx);
}

function addComment(ctx, cx) {
  const editor = ctx.inputs["spec.block"];
  const body = String(ctx.state.body ?? "").trim();
  if (editor === undefined || body === "") return;
  const range = editor.selected_range();
  const anchor = quoteAnchor(editor.value(), range.start, range.end);
  const id = nextCommentId(ctx.view?.spec?.comments ?? []);
  sendEvent(ctx, { type: "SPEC_COMMENT", comment: { id, quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix, body } }, cx);
  ctx.inputs["spec.body"]?.set_value("");
  closeComment(ctx, cx);
}

function openRequest(ctx, cx) {
  const first = ctx.inputs["spec.note"] === undefined;
  const note = fieldInput(ctx, "spec.note", "", cx);
  if (first) note.on("change", (_event, inputCx) => ctx.setState({ note: note.value() }, inputCx));
  ctx.setState({ requesting: true, editing: true }, cx);
}

function closeRequest(ctx, cx) {
  ctx.setState({ requesting: false, editing: false, note: "" }, cx);
}

function sendChanges(ctx, cx) {
  const note = String(ctx.state.note ?? "").trim();
  sendEvent(ctx, { type: "SPEC_CHANGES_REQUESTED", ...(note === "" ? {} : { note }) }, cx);
  ctx.inputs["spec.note"]?.set_value("");
  closeRequest(ctx, cx);
}

function openReply(ctx, comment, cx) {
  const first = ctx.inputs["spec.reply"] === undefined;
  const reply = fieldInput(ctx, "spec.reply", "", cx);
  if (first) reply.on("change", (_event, inputCx) => ctx.setState({ reply: reply.value() }, inputCx));
  ctx.setState({ replyTo: comment.id, editing: true }, cx);
}

function closeReply(ctx, cx) {
  ctx.setState({ replyTo: "", editing: false, reply: "" }, cx);
}

function sendReply(ctx, comment, cx) {
  const body = String(ctx.state.reply ?? "").trim();
  if (body === "") return;
  const id = nextCommentId(ctx.view?.spec?.comments ?? []);
  sendEvent(
    ctx,
    { type: "SPEC_COMMENT", comment: { id, quote: comment.quote, prefix: comment.prefix ?? "", suffix: comment.suffix ?? "", body, replyTo: comment.id } },
    cx,
  );
  ctx.inputs["spec.reply"]?.set_value("");
  closeReply(ctx, cx);
}

/** One person event through the router; a refusal is this screen's own error line (§9.1 rule 3). */
function sendEvent(ctx, event, cx) {
  cx.spawn(async (asyncCx) => {
    const outcome = await ctx.send(event);
    ctx.setState({ error: outcome.ok ? "" : outcome.error }, asyncCx);
  });
}

/** `#rrggbb` with an alpha byte: the soft tint the design puts behind a highlighted quote. */
function tint(hex, alpha) {
  if (typeof hex !== "string" || !hex.startsWith("#") || hex.length !== 7) return hex;
  return `${hex}${alpha}`;
}
