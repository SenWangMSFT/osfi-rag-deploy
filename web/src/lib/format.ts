export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-CA');
}

export function pageLabel(from: number | null | undefined, to?: number | null): string {
  if (from == null) return '';
  return to != null && to !== from ? `pp. ${from}–${to}` : `p. ${from}`;
}

// Full class strings so Tailwind can see them at build time.
const TONES = [
  'bg-sky-50 text-sky-700 ring-sky-200',
  'bg-emerald-50 text-emerald-700 ring-emerald-200',
  'bg-violet-50 text-violet-700 ring-violet-200',
  'bg-rose-50 text-rose-700 ring-rose-200',
  'bg-amber-50 text-amber-800 ring-amber-200',
  'bg-teal-50 text-teal-700 ring-teal-200',
  'bg-indigo-50 text-indigo-700 ring-indigo-200',
  'bg-orange-50 text-orange-700 ring-orange-200',
  'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200',
];

export function institutionTone(name: string): string {
  let hash = 7;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length] ?? TONES[0]!;
}

/** Short badge text: "RBC", "TD", "SCO" for Scotiabank, "AS" for Alterna Savings. */
export function institutionMark(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length > 1) return words.map((word) => word[0]).join('').slice(0, 3).toUpperCase();
  const word = words[0]!;
  return (word.length <= 4 ? word : word.slice(0, 3)).toUpperCase();
}
