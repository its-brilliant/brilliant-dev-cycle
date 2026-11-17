// Types for kit/words.js: the app's own labels and the counting helpers.

export const STEPS: string[];
export function stepOf(stage: string): number;
export function plural(count: number, one: string, many?: string): string;
export function joinWords(items: string[]): string;
export function authorLabel(from: string): string;
