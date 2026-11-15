const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** True for `2026-01-01T00:00:00Z` or the same instant with millisecond precision. */
export function isIsoUtc(value: string): boolean {
  if (!ISO_UTC.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const canonical = parsed.toISOString();
  return canonical === value || canonical.replace('.000', '') === value;
}
