/**
 * Source maps (version 3) for the generated JavaScript: one mapping per generated line, pointing at
 * the start of the Xenon statement or declaration it came from. Also the decoder the stack-trace
 * remapper (`src/runtime/stacktrace.ts`) uses.
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
 * A map for one generated file with one source. `lines[i]` is the origin of generated line `i`
 * (undefined: not mapped); each mapped line gets one segment at its first non-blank column.
 */
export function buildSourceMap(file: string, source: string, content: string, lines: { text: string; origin?: LineOrigin }[]): SourceMap {
  let prevLine = 0;
  let prevCol = 0;
  const mappings = lines.map(({ text, origin }) => {
    if (!origin) return "";
    const genCol = text.length - text.trimStart().length;
    const seg = vlq(genCol) + vlq(0) + vlq(origin.line - prevLine) + vlq(origin.col - prevCol);
    prevLine = origin.line;
    prevCol = origin.col;
    return seg;
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
