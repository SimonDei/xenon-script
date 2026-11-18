/** Damerau–Levenshtein (optimal string alignment) distance. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/** Best "did you mean" candidate, or undefined if nothing is close enough. */
export function suggest(name: string, candidates: Iterable<string>): string | undefined {
  // Short names only get case-insensitive matches; longer ones allow ~1 edit per 3 characters.
  const max = Math.floor(name.length / 3);
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of new Set(candidates)) {
    if (c === name) continue;
    const dist = c.toLowerCase() === name.toLowerCase() ? 0.5 : editDistance(name, c);
    if (dist <= max && dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}
