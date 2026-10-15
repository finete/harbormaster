// Deterministic accent color per repository short name, pi-home style: the
// TUI gave every repo a recognizable hue so columns scan by color before
// text. Fixed palette (readable on the dark theme), FNV-1a hash for spread.
const PALETTE = [
  "text-violet-400",
  "text-sky-400",
  "text-emerald-400",
  "text-amber-400",
  "text-rose-400",
  "text-cyan-400",
  "text-lime-400",
  "text-fuchsia-400",
] as const;

export function repoColorClass(label: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return PALETTE[(hash >>> 0) % PALETTE.length] as string;
}
