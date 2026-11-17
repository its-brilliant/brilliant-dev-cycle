// People words (spec §9.1 rule 4).
//
// Nothing here turns an id, an enum or a path into a sentence: the view already carries the words
// a person reads (`stageWords`, each phase's `words`, each finding's `summary`). This module holds
// only the labels that are the app's own chrome — the six stage names of the stepper (§9.2) — and
// the few counting helpers the screens share.

/** The stepper (spec §9.2): Goal · Spec · Plan · Build · Review · Ship. */
export const STEPS = ['Goal', 'Spec', 'Plan', 'Build', 'Review', 'Ship'];

/** Which stepper step a run stage is on; -1 for a run that ended without one. */
export function stepOf(stage) {
  switch (stage) {
    case 'intake':
      return 0;
    case 'specDrafting':
    case 'specReview':
      return 1;
    case 'planning':
    case 'planReview':
      return 2;
    case 'building':
      return 3;
    case 'finalReview':
      return 4;
    case 'shipping':
    case 'done':
      return 5;
    default:
      return -1;
  }
}

/** `1 phase`, `3 phases`: a count and its word, never `1 phase(s)`. */
export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** `a`, `a and b`, `a, b and c`: a list a person reads aloud. */
export function joinWords(items) {
  const words = items.filter((item) => typeof item === 'string' && item !== '');
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The transcript's author label: the person is "You", the PM is "PM" (spec §9.4). */
export function authorLabel(from) {
  return from === 'pm' ? 'PM' : 'You';
}
