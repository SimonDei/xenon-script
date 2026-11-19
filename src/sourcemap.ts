/**
 * Source maps (version 3) for the generated JavaScript: every generated line maps to the start of
 * the Xenon statement or declaration it came from, and every name or literal to its own position.
 * Also the decoder the stack-trace remapper (`src/runtime/stacktrace.ts`) uses.
 */
import type { Span } from "./source.ts";

export interface SourceMap {
  version: 3;
  file: string;
  sources: string[];
  sourcesContent: (string | null)[];
  names: string[];
  mappings: string;
}

/** A generated line's origin: 0-based line and column in the source. */
export interface LineOrigin {
  line: number;
  col: number;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(n: number): string {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v) digit |= 32;
    out += B64[digit];
  } while (v);
  return out;
}

/** The origin of a span's start (0-based, as source maps count). */
export function originOf(s: Span): LineOrigin {
  const { line, col } = s.file.position(s.start);
  return { line: line - 1, col: col - 1 };
}

/**
 * A map for one generated file with one source. Each generated line maps its first non-blank
 * column to `origin` (the statement it came from; undefined: not mapped), plus the start of every
 * token in `segments` (names and literals, for column-exact positions).
 */
export function buildSourceMap(
  file: string,
  source: string,
  content: string,
  lines: { text: string; origin?: LineOrigin; segments?: { col: number; origin: LineOrigin }[] }[],
): SourceMap {
  let prevLine = 0;
  let prevCol = 0;
  const mappings = lines.map(({ text, origin, segments = [] }) => {
    const byCol = new Map<number, LineOrigin>();
    if (origin) byCol.set(text.length - text.trimStart().length, origin);
    for (const s of segments) byCol.set(s.col, s.origin); // a token at the line's start wins
    let prevGen = 0;
    return [...byCol].sort((a, b) => a[0] - b[0]).map(([col, at]) => {
      const seg = vlq(col - prevGen) + vlq(0) + vlq(at.line - prevLine) + vlq(at.col - prevCol);
      prevGen = col;
      prevLine = at.line;
      prevCol = at.col;
      return seg;
    }).join(",");
  });
  return { version: 3, file, sources: [source], sourcesContent: [content], names: [], mappings: mappings.join(";") };
}

/** Decodes `mappings` into, per generated line, its segments `[genCol, source, line, col]` (0-based, absolute). */
export function decodeMappings(mappings: string): [number, number, number, number][][] {
  const out: [number, number, number, number][][] = [];
  let source = 0;
  let line = 0;
  let col = 0;
  for (const group of mappings.split(";")) {
    const segs: [number, number, number, number][] = [];
    let genCol = 0;
    for (const seg of group.split(",")) {
      if (!seg) continue;
      const values: number[] = [];
      let shift = 0;
      let value = 0;
      for (const ch of seg) {
        const digit = B64.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          shift = 0;
          value = 0;
        }
      }
      genCol += values[0] ?? 0;
      if (values.length >= 4) {
        source += values[1]!;
        line += values[2]!;
        col += values[3]!;
        segs.push([genCol, source, line, col]);
      }
    }
    out.push(segs);
  }
  return out;
}
