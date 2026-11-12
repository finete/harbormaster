// Repository labels are uniformly the brand mint (owner decision, then the
// design system: "green/teal is only ever the mint token"): the earlier
// hash-assigned palette gave repos colors that read as semantic states —
// arnac landed on rose and looked like an error. Repo names are landmarks,
// not statuses; one calm accent does the scanning job without lying.
export function repoColorClass(_label: string): string {
  return "text-primary";
}
