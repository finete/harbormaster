// Utility: compact token counts for the usage chip, cards and the Costs view
// (docs/costs.md): `412`, `1.9k`, `92k`, `1.9M`, `9.8M`, `412M`. One decimal
// under 10 of a unit, none at or above; `k` from 1,000, `M` from 1,000,000.

const UNITS: ReadonlyArray<{ size: number; suffix: string }> = [
  { size: 1_000_000_000, suffix: "B" },
  { size: 1_000_000, suffix: "M" },
  { size: 1_000, suffix: "k" },
];

function scaled(value: number): string | undefined {
  if (value < 9.95) return value.toFixed(1);
  const whole = Math.round(value);
  return whole < 1000 ? String(whole) : undefined;
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n < 0) return `-${formatTokenCount(-n)}`;
  const rounded = Math.round(n);
  if (rounded < 1000) return String(rounded);
  // Smallest unit whose figure stays under 1000 after rounding
  // (999,600 is "1.0M", never "1000k").
  for (let index = UNITS.length - 1; index >= 0; index -= 1) {
    const unit = UNITS[index] as { size: number; suffix: string };
    const text = scaled(n / unit.size);
    if (text !== undefined || index === 0) {
      return `${text ?? String(Math.round(n / unit.size))}${unit.suffix}`;
    }
  }
  return String(rounded);
}
