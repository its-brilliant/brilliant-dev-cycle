// The spec's plain parts (spec §4.2): splitting the rendered markdown into the blocks a person
// comments on, anchoring a comment to the words it quotes, and the order the comments are listed
// in. Pure: no imports, so tests/herdr/screens-u2.test.ts drives it directly (screens/spec.js is
// what draws it).

/** How much text before and after the quote travels with it, so the anchor survives small edits. */
export const AROUND = 40;

/**
 * The spec as blocks: one per heading, paragraph, list item, table or fenced code block, each with
 * its own text so a comment can be anchored to it. Blank lines are not blocks.
 */
export function splitBlocks(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const blocks = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? '';
    if (line.trim() === '') {
      at += 1;
      continue;
    }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence !== null) {
      const taken = [line];
      at += 1;
      while (at < lines.length) {
        const next = lines[at] ?? '';
        taken.push(next);
        at += 1;
        if (next.trim().startsWith(fence[1])) break;
      }
      blocks.push({ kind: 'code', text: taken.join('\n').trim() });
      continue;
    }
    const heading = /^(#{1,6})\s+/.exec(line);
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: line.trim() });
      at += 1;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const taken = [];
      while (at < lines.length && /^\s*\|/.test(lines[at] ?? '')) {
        taken.push((lines[at] ?? '').trim());
        at += 1;
      }
      blocks.push({ kind: 'table', text: taken.join('\n') });
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      blocks.push({ kind: 'item', text: line.trim() });
      at += 1;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ kind: 'rule', text: line.trim() });
      at += 1;
      continue;
    }
    const taken = [];
    while (at < lines.length && !startsBlock(lines[at] ?? '')) {
      taken.push((lines[at] ?? '').trim());
      at += 1;
    }
    blocks.push({ kind: 'paragraph', text: taken.join('\n').trim() });
  }
  return blocks.map((block, index) => ({ ...block, index, id: `b${index}` }));
}

/** True for a line that begins a block of its own, so a paragraph stops there. */
function startsBlock(line) {
  if (line.trim() === '') return true;
  return (
    /^\s*(```|~~~)/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*\|/.test(line) ||
    /^\s*([-*+]|\d+[.)])\s+/.test(line) ||
    /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)
  );
}

/**
 * The words a selection quotes, with the text around them (§4.2): `start`/`end` are UTF-16 offsets
 * into `text`, as an editor reports them. A selection of nothing, or of spaces only, means the
 * whole block is the quote.
 */
export function quoteAnchor(text, start, end) {
  const source = String(text ?? '');
  const whole = source.trim();
  let from = clamp(Number(start), 0, source.length);
  let to = clamp(Number(end), 0, source.length);
  if (to < from) [from, to] = [to, from];
  while (from < to && /\s/.test(source[from])) from += 1;
  while (to > from && /\s/.test(source[to - 1])) to -= 1;
  if (from >= to) return { quote: whole, prefix: '', suffix: '' };
  return {
    quote: source.slice(from, to),
    prefix: source.slice(Math.max(0, from - AROUND), from),
    suffix: source.slice(to, Math.min(source.length, to + AROUND)),
  };
}

function clamp(value, low, high) {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(value, low), high);
}

/**
 * The block's text split around the quotes its comments anchor to: `[{ text, commentId }]`, in
 * order, with `commentId: null` for the parts nobody commented on. That is how a quote gets a
 * background in the rendered block: the quote is its own piece. A quote that is not in this text
 * (the spec changed under it) is left out, and overlapping quotes keep the first.
 */
export function highlightSegments(text, comments) {
  const source = String(text ?? '');
  const spans = [];
  for (const comment of Array.isArray(comments) ? comments : []) {
    const quote = typeof comment?.quote === 'string' ? comment.quote : '';
    if (quote === '' || quote === source) continue;
    const at = bestIndex(source, quote, comment?.prefix, comment?.suffix);
    if (at < 0) continue;
    spans.push({ start: at, end: at + quote.length, id: String(comment.id ?? '') });
  }
  spans.sort((left, right) => left.start - right.start);
  const segments = [];
  let at = 0;
  for (const span of spans) {
    if (span.start < at) continue;
    if (span.start > at) segments.push({ text: source.slice(at, span.start), commentId: null });
    segments.push({ text: source.slice(span.start, span.end), commentId: span.id });
    at = span.end;
  }
  if (at < source.length || segments.length === 0) segments.push({ text: source.slice(at), commentId: null });
  return segments;
}

/** Where a quote sits in the text: the occurrence its prefix and suffix agree with most. */
function bestIndex(source, quote, prefix, suffix) {
  const before = typeof prefix === 'string' ? prefix : '';
  const after = typeof suffix === 'string' ? suffix : '';
  let best = -1;
  let bestScore = -1;
  let at = source.indexOf(quote);
  while (at >= 0) {
    const score = commonEnd(source.slice(0, at), before) + commonStart(source.slice(at + quote.length), after);
    if (score > bestScore) {
      best = at;
      bestScore = score;
    }
    at = source.indexOf(quote, at + 1);
  }
  return best;
}

function commonEnd(text, tail) {
  let count = 0;
  while (count < text.length && count < tail.length && text[text.length - 1 - count] === tail[tail.length - 1 - count]) count += 1;
  return count;
}

function commonStart(text, head) {
  let count = 0;
  while (count < text.length && count < head.length && text[count] === head[count]) count += 1;
  return count;
}

/**
 * The comments as threads: each root with its replies, open ones first and resolved ones last
 * (§4.2: "a narrow column on the right lists comments (open first) with their quote"). A reply
 * whose parent is gone is shown as a thread of its own rather than dropped.
 */
export function commentThreads(comments) {
  const all = (Array.isArray(comments) ? comments : []).filter((comment) => comment !== null && typeof comment === 'object' && typeof comment.id === 'string');
  const roots = all.filter((comment) => typeof comment.replyTo !== 'string' || comment.replyTo === '');
  const known = new Set(roots.map((comment) => comment.id));
  const threads = roots.map((comment) => ({ comment, replies: all.filter((reply) => reply.replyTo === comment.id) }));
  for (const comment of all) {
    if (typeof comment.replyTo === 'string' && comment.replyTo !== '' && !known.has(comment.replyTo)) threads.push({ comment, replies: [] });
  }
  const open = threads.filter((thread) => thread.comment.resolved !== true);
  const resolved = threads.filter((thread) => thread.comment.resolved === true);
  return [...open, ...resolved];
}

/** How many comments are still open: what Request changes has to work with. */
export function openCount(comments) {
  return (Array.isArray(comments) ? comments : []).filter((comment) => comment?.resolved !== true).length;
}

/** A new comment's id: unique among the comments the view carries, and readable in a transcript. */
export function nextCommentId(comments) {
  const ids = new Set((Array.isArray(comments) ? comments : []).map((comment) => String(comment?.id ?? '')));
  let number = (Array.isArray(comments) ? comments.length : 0) + 1;
  while (ids.has(`c${number}`)) number += 1;
  return `c${number}`;
}
