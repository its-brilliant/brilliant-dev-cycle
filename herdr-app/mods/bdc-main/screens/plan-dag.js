// The plan's plain part (spec §4.3, frame 02): where each phase sits in the DAG and how the edges
// between them are drawn. Pure: no imports, so tests/herdr/screens-u2.test.ts drives it directly
// (screens/plan.js is what draws the cards and the lines).

/** A phase card's size in px, and the space between cards and between columns. */
// Four rows (id, title, counts, proof pills) and their gaps need 100px; 78 cut the last row off.
export const CARD = { width: 196, height: 100 };
export const SPACING = { pad: 16, gapX: 56, gapY: 28 };

/**
 * Each phase's depth in the graph: 0 for a phase with no deps, else one more than its deepest dep.
 * A dep that is not in the plan is ignored (the plan was edited), and a cycle is reported instead
 * of being followed forever: the phases in it keep a depth, so the graph still draws.
 */
export function dagDepths(phases) {
  const list = (Array.isArray(phases) ? phases : []).filter((phase) => phase !== null && typeof phase === 'object' && typeof phase.id === 'string');
  const byId = new Map(list.map((phase) => [phase.id, phase]));
  const depth = new Map();
  const cyclic = new Set();
  for (const phase of list) visit(phase.id, byId, depth, cyclic, new Set());
  return { depth, cyclic: [...cyclic] };
}

function visit(id, byId, depth, cyclic, seen) {
  const known = depth.get(id);
  if (known !== undefined) return known;
  if (seen.has(id)) {
    cyclic.add(id);
    return 0;
  }
  seen.add(id);
  let value = 0;
  for (const dep of depsOf(byId.get(id))) {
    if (!byId.has(dep)) continue;
    value = Math.max(value, visit(dep, byId, depth, cyclic, seen) + 1);
  }
  seen.delete(id);
  depth.set(id, value);
  return value;
}

function depsOf(phase) {
  return (Array.isArray(phase?.deps) ? phase.deps : []).filter((dep) => typeof dep === 'string');
}

/**
 * The whole DAG: `{ width, height, cards, edges, cyclic, depthOf }`, in canvas px.
 *
 * Columns are depths, so a card sits right of everything it depends on; rows are the order the
 * planner wrote. Each edge is a list of 1px rectangles (`left`, `top`, `width`, `height`) routed
 * through the gap below the source row and the gap left of the target column, so a line never
 * crosses a card: a source in the target's own row goes straight across, everything else goes
 * down into the row gap, across, and up into the target's left edge.
 */
export function dagLayout(phases, options = {}) {
  const card = { ...CARD, ...(options.card ?? {}) };
  const pad = options.pad ?? SPACING.pad;
  const gapX = options.gapX ?? SPACING.gapX;
  const gapY = options.gapY ?? SPACING.gapY;
  const list = (Array.isArray(phases) ? phases : []).filter((phase) => phase !== null && typeof phase === 'object' && typeof phase.id === 'string');
  const { depth, cyclic } = dagDepths(list);
  const columns = [];
  for (const phase of list) {
    const at = depth.get(phase.id) ?? 0;
    while (columns.length <= at) columns.push([]);
    columns[at].push(phase);
  }
  const cards = [];
  const boxes = new Map();
  columns.forEach((column, columnIndex) => {
    column.forEach((phase, row) => {
      const box = {
        id: phase.id,
        phase,
        depth: columnIndex,
        row,
        x: pad + columnIndex * (card.width + gapX),
        y: pad + row * (card.height + gapY),
        width: card.width,
        height: card.height,
      };
      cards.push(box);
      boxes.set(phase.id, box);
    });
  });
  const edges = [];
  for (const phase of list) {
    const to = boxes.get(phase.id);
    for (const dep of depsOf(phase)) {
      const from = boxes.get(dep);
      // A cycle has no left-to-right edge to draw; the screen says the plan has one instead.
      if (from === undefined || to === undefined || to.depth <= from.depth) continue;
      edges.push({ from: dep, to: phase.id, segments: elbow(from, to, gapX, gapY) });
    }
  }
  return {
    width: cards.reduce((widest, box) => Math.max(widest, box.x + box.width), 0) + pad,
    height: cards.reduce((tallest, box) => Math.max(tallest, box.y + box.height), 0) + pad,
    cards,
    edges,
    cyclic,
    depthOf: Object.fromEntries(depth),
  };
}

/** One edge as 1px rectangles: down into the row gap, across, then into the target's left edge. */
function elbow(from, to, gapX, gapY) {
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  if (from.row === to.row && to.depth === from.depth + 1) return [line(startX, startY, endX - startX, 1)];
  const lane = to.x - Math.round(gapX / 2);
  const bottomX = from.x + from.width / 2;
  const bottomY = from.y + from.height + Math.round(gapY / 2);
  const segments = [line(bottomX, from.y + from.height, 1, bottomY - (from.y + from.height))];
  segments.push(line(bottomX, bottomY, lane - bottomX, 1));
  segments.push(line(lane, Math.min(bottomY, endY), 1, Math.abs(endY - bottomY)));
  segments.push(line(lane, endY, endX - lane, 1));
  return segments;
}

function line(left, top, width, height) {
  return { left: Math.round(left), top: Math.round(top), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/** The phases that wait on one phase: what it unlocks (§4.3's inspector says so). */
export function dependants(phases, id) {
  return (Array.isArray(phases) ? phases : []).filter((phase) => depsOf(phase).includes(id)).map((phase) => phase.id);
}

/** A phase's checks in words: the command, or the agent that runs it. */
export function checkWords(check) {
  if (typeof check?.run === 'string' && check.run !== '') return check.run;
  if (typeof check?.agent === 'string' && check.agent !== '') return `${check.agent} (an agent)`;
  return '';
}

/** The proof kinds a phase needs, in the order it lists them, without repeats: the pills on a card. */
export function proofKinds(phase) {
  const kinds = [];
  for (const item of Array.isArray(phase?.proof) ? phase.proof : []) {
    const kind = String(item?.kind ?? '');
    if (kind !== '' && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

/** `1 task`, `3 tasks`: a count and its word (§9.1 rule 4). */
export function countWords(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}
