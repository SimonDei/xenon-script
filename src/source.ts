/** A source file with fast offset → line/column lookup. */
/**
 * A source folder other than the project's own (`"sources"` in xenon.json): where its files are on
 * disk, and the folder as seen from the output directory (for source maps).
 */
export interface SourceRoot {
  dir: string;
  mapRoot?: string;
}

export class SourceFile {
  readonly lineStarts: number[];
  /** Set for a file from another source folder (see `SourceRoot`); unset for the project's own. */
  root?: SourceRoot;

  constructor(
    readonly path: string,
    readonly text: string,
    /** Part of the built-in prelude (shipped with the compiler, not user code). */
    readonly prelude = false,
    /** Declarations generated from `.d.ts` files for JavaScript imports (src/dts.ts): checked, never emitted. */
    readonly generated = false,
  ) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
    }
    this.lineStarts = starts;
  }

  /** 1-based line number containing `offset`. */
  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** 1-based line and column (column counted in characters). */
  position(offset: number): { line: number; col: number } {
    const line = this.lineOf(offset);
    return { line, col: offset - this.lineStarts[line - 1]! + 1 };
  }

  /** Text of a 1-based line, without the line terminator. */
  lineText(line: number): string {
    const start = this.lineStarts[line - 1] ?? this.text.length;
    const next = this.lineStarts[line];
    let end = next === undefined ? this.text.length : next - 1;
    if (end > start && this.text.charCodeAt(end - 1) === 13 /* \r */) end--;
    return this.text.slice(start, end);
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }
}

/** Half-open character range [start, end) in a source file. */
export interface Span {
  file: SourceFile;
  start: number;
  end: number;
}

export function span(file: SourceFile, start: number, end: number): Span {
  return { file, start, end };
}

/** Smallest span covering both. */
export function cover(a: Span, b: Span): Span {
  return { file: a.file, start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

export function spanText(s: Span): string {
  return s.file.text.slice(s.start, s.end);
}
