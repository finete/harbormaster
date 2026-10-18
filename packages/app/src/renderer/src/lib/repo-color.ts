// Repository labels are uniformly green (owner decision): the earlier
// hash-assigned palette gave repos colors that read as semantic states —
// arnac landed on rose and looked like an error. Repo names are landmarks,
// not statuses; one calm accent does the scanning job without lying.
export function repoColorClass(_label: string): string {
  return "text-lime-400";
}
