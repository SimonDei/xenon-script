import type { SourceFile, Span } from "./source.ts";

export type Severity = "error" | "warning" | "note";

export interface Label {
  span: Span;
  message?: string;
  primary: boolean;
}

export interface Edit {
  span: Span;
  text: string;
}

export interface Help {
  message: string;
  edits?: Edit[];
}

export interface Diagnostic {
  severity: Severity;
  code?: string;
  message: string;
  labels: Label[];
  notes: string[];
  help: Help[];
}

/** Fluent helper for building a diagnostic in place. */
export class DiagnosticBuilder {
  constructor(readonly diagnostic: Diagnostic) {}

  primary(span: Span, message?: string): this {
    this.diagnostic.labels.push({ span, message, primary: true });
    return this;
  }

  secondary(span: Span, message?: string): this {
    this.diagnostic.labels.push({ span, message, primary: false });
    return this;
  }

  note(message: string): this {
    this.diagnostic.notes.push(message);
    return this;
  }

  help(message: string, edits?: Edit[]): this {
    this.diagnostic.help.push({ message, edits });
    return this;
  }
}

/** Collects diagnostics; dedupes identical ones and caps the count. */
export class DiagnosticBag {
  readonly items: Diagnostic[] = [];
  private seen = new Set<string>();
  /** Errors beyond `maxErrors` that were dropped. */
  omitted = 0;

  constructor(readonly maxErrors = 50) {}

  private add(severity: Severity, code: string | undefined, message: string, span?: Span, label?: string) {
    const d: Diagnostic = { severity, code, message, labels: [], notes: [], help: [] };
    if (span) d.labels.push({ span, message: label, primary: true });
    if (severity === "error" && this.errorCount >= this.maxErrors) {
      this.omitted++;
      return new DiagnosticBuilder(d); // built but not kept
    }
    const key = `${severity}|${code}|${message}|${span?.file.path}|${span?.start}`;
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.items.push(d);
    }
    return new DiagnosticBuilder(d);
  }

  error(code: string, message: string, span?: Span, label?: string) {
    return this.add("error", code, message, span, label);
  }

  warning(code: string, message: string, span?: Span, label?: string) {
    return this.add("warning", code, message, span, label);
  }

  /** Diagnostics ordered by file, then position (stable for equal positions). */
  sorted(): Diagnostic[] {
    const key = (d: Diagnostic) => {
      const l = d.labels.find((x) => x.primary) ?? d.labels[0];
      return l ? [l.span.file.path, l.span.start] as const : ["", -1] as const;
    };
    return [...this.items].sort((x, y) => {
      const [fa, sa] = key(x);
      const [fb, sb] = key(y);
      return fa < fb ? -1 : fa > fb ? 1 : sa - sb;
    });
  }

  /**
   * Drops warnings silenced in the source: `/* klass-allow K0840 *\/` earlier on the warned
   * line, or `// klass-allow K0840` on the line above. Errors can't be silenced.
   */
  applySuppressions() {
    const allowed = (d: Diagnostic): boolean => {
      const l = d.labels.find((x) => x.primary) ?? d.labels[0];
      if (d.severity !== "warning" || !d.code || !l) return false;
      const file = l.span.file;
      const line = file.lineOf(l.span.start);
      const before = file.text.slice(file.lineStarts[line - 1]!, l.span.start);
      const inline = /\/\*\s*klass-allow\s+([^*]*)\*\//.exec(before);
      const above = line > 1 ? /^\s*\/\/\s*klass-allow\s+(.*)$/.exec(file.lineText(line - 1)) : null;
      return [inline, above].some((m) => !!m && m[1]!.split(/[\s,]+/).includes(d.code!));
    };
    const kept = this.items.filter((d) => !allowed(d));
    this.items.length = 0;
    this.items.push(...kept);
  }

  get errorCount(): number {
    return this.items.filter((d) => d.severity === "error").length;
  }

  get warningCount(): number {
    return this.items.filter((d) => d.severity === "warning").length;
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

export interface RenderOptions {
  color: boolean;
  /** Path displayed for a file (e.g. relative to cwd). */
  displayPath?: (file: SourceFile) => string;
}

const TAB = "    ";

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
};

class Painter {
  constructor(private enabled: boolean) {}
  paint(text: string, ...styles: (keyof typeof ansi)[]): string {
    if (!this.enabled || text === "") return text;
    return styles.map((s) => ansi[s]).join("") + text + ansi.reset;
  }
}

function severityStyle(sev: Severity): keyof typeof ansi {
  return sev === "error" ? "red" : sev === "warning" ? "yellow" : "cyan";
}

/** Display width of a string, with tabs expanded. */
function width(text: string): number {
  return Bun.stringWidth(text.replaceAll("\t", TAB));
}

function expandTabs(text: string): string {
  return text.replaceAll("\t", TAB);
}

interface LineLabel {
  startCol: number; // display column, 0-based
  endCol: number; // exclusive, display column
  label: Label;
}

export function renderDiagnostic(d: Diagnostic, opts: RenderOptions): string {
  const p = new Painter(opts.color);
  const show = opts.displayPath ?? ((f: SourceFile) => f.path);
  const out: string[] = [];
  const sevColor = severityStyle(d.severity);

  const head = d.code ? `${d.severity}[${d.code}]` : d.severity;
  out.push(p.paint(head, "bold", sevColor) + p.paint(`: ${d.message}`, "bold"));

  // Group labels by file, primary file first.
  const primary = d.labels.find((l) => l.primary) ?? d.labels[0];
  const files: SourceFile[] = [];
  if (primary) files.push(primary.span.file);
  for (const l of d.labels) if (!files.includes(l.span.file)) files.push(l.span.file);

  // Gutter width over every line we will print (labels + help edits).
  let maxLine = 1;
  for (const l of d.labels) maxLine = Math.max(maxLine, l.span.file.lineOf(l.span.start));
  for (const h of d.help) for (const e of h.edits ?? []) maxLine = Math.max(maxLine, e.span.file.lineOf(e.span.start));
  const gw = String(maxLine).length;
  const gutter = (n?: number) => p.paint(`${n === undefined ? " ".repeat(gw) : String(n).padStart(gw)} |`, "bold", "blue");
  const empty = p.paint(`${" ".repeat(gw)} |`, "bold", "blue");

  files.forEach((file, i) => {
    const labels = d.labels.filter((l) => l.span.file === file);
    const anchor = labels.find((l) => l.primary) ?? labels[0]!;
    const pos = file.position(anchor.span.start);
    const arrow = i === 0 ? "-->" : ":::";
    if (i > 0) out.push(empty);
    out.push(`${" ".repeat(gw)}${p.paint(arrow, "bold", "blue")} ${show(file)}:${pos.line}:${pos.col}`);
    out.push(empty);

    // Bucket labels by their start line.
    const byLine = new Map<number, LineLabel[]>();
    for (const label of labels) {
      const line = file.lineOf(label.span.start);
      const lineStart = file.lineStarts[line - 1]!;
      const text = file.lineText(line);
      const startIdx = label.span.start - lineStart;
      // Multi-line spans are underlined to the end of their first line.
      const endIdx = Math.min(Math.max(label.span.end - lineStart, startIdx + 1), Math.max(text.length, startIdx + 1));
      const startCol = width(text.slice(0, startIdx));
      const endCol = Math.max(startCol + 1, width(text.slice(0, endIdx)));
      const arr = byLine.get(line) ?? [];
      arr.push({ startCol, endCol, label });
      byLine.set(line, arr);
    }

    const lines = [...byLine.keys()].sort((a, b) => a - b);
    let prev: number | undefined;
    for (const line of lines) {
      if (prev !== undefined && line - prev > 1) out.push(p.paint("...", "bold", "blue"));
      out.push(`${gutter(line)} ${expandTabs(file.lineText(line))}`);
      const lineLabels = byLine.get(line)!.sort((a, b) => a.startCol - b.startCol);
      out.push(...renderUnderlines(lineLabels, empty, p, sevColor));
      prev = line;
    }
  });

  if (d.labels.length > 0 && (d.notes.length > 0 || d.help.length > 0)) out.push(empty);

  for (const note of d.notes) {
    out.push(`${" ".repeat(gw)} ${p.paint("=", "bold", "blue")} ${p.paint("note", "bold")}: ${note}`);
  }

  for (const h of d.help) {
    out.push(`${p.paint("help", "bold", "cyan")}: ${h.message}`);
    if (h.edits && h.edits.length > 0) {
      out.push(empty);
      out.push(...renderEdits(h.edits, gutter, empty, p));
    }
  }

  return out.join("\n");
}

/**
 * Underlines for one source line. Non-overlapping labels share one row, rustc-style:
 * the rightmost message goes inline, the others hang below on `|` connectors.
 */
function renderUnderlines(labels: LineLabel[], empty: string, p: Painter, sevColor: keyof typeof ansi): string[] {
  const style = (l: LineLabel) => (l.label.primary ? sevColor : "blue");
  const overlap = labels.some((l, i) => i > 0 && l.startCol < labels[i - 1]!.endCol);
  if (overlap) {
    return labels.map((l) => {
      const marks = (l.label.primary ? "^" : "-").repeat(l.endCol - l.startCol);
      const msg = l.label.message ? ` ${l.label.message}` : "";
      return `${empty} ${" ".repeat(l.startCol)}${p.paint(marks + msg, "bold", style(l))}`;
    });
  }
  // Builds a row from (column, text, label) pieces placed left to right.
  const row = (pieces: { col: number; text: string; l: LineLabel }[]) => {
    let text = "";
    let width = 0;
    for (const piece of pieces) {
      text += " ".repeat(Math.max(0, piece.col - width)) + p.paint(piece.text, "bold", style(piece.l));
      width = piece.col + Bun.stringWidth(piece.text);
    }
    return `${empty} ${text}`.trimEnd();
  };
  const last = labels.at(-1)!;
  const marks = labels.map((l) => ({ col: l.startCol, text: (l.label.primary ? "^" : "-").repeat(l.endCol - l.startCol), l }));
  if (last.label.message) marks[marks.length - 1]!.text += ` ${last.label.message}`;
  const out = [row(marks)];
  const hanging = labels.slice(0, -1).filter((l) => l.label.message);
  for (let i = hanging.length - 1; i >= 0; i--) {
    const current = hanging[i]!;
    const left = hanging.slice(0, i);
    out.push(row([...left, current].map((l) => ({ col: l.startCol, text: "|", l }))));
    out.push(row([...left.map((l) => ({ col: l.startCol, text: "|", l })), { col: current.startCol, text: current.label.message!, l: current }]));
  }
  return out;
}

/** Shows each edited line with the edits applied and `+`/`~` markers below. */
function renderEdits(
  edits: Edit[],
  gutter: (n?: number) => string,
  empty: string,
  p: Painter,
): string[] {
  const out: string[] = [];
  const byLine = new Map<string, Edit[]>();
  for (const e of edits) {
    const line = e.span.file.lineOf(e.span.start);
    const key = `${e.span.file.path}:${line}`;
    const arr = byLine.get(key) ?? [];
    arr.push(e);
    byLine.set(key, arr);
  }
  for (const group of byLine.values()) {
    const file = group[0]!.span.file;
    const line = file.lineOf(group[0]!.span.start);
    const lineStart = file.lineStarts[line - 1]!;
    const original = file.lineText(line);
    group.sort((a, b) => a.span.start - b.span.start);

    let patched = "";
    let marks = "";
    let cursor = 0;
    for (const e of group) {
      const s = e.span.start - lineStart;
      const end = Math.min(e.span.end - lineStart, original.length);
      const kept = original.slice(cursor, s);
      patched += kept;
      marks += " ".repeat(width(kept));
      patched += e.text;
      const mark = e.span.end > e.span.start ? "~" : "+";
      marks += mark.repeat(width(e.text));
      cursor = end;
    }
    patched += original.slice(cursor);
    if (patched.includes("\n")) {
      // Multi-line insertion: inserted lines are marked `+` in the gutter, rustc-style.
      const lines = patched.split("\n");
      const width = gutter(line).replace(/\x1b\[[0-9;]*m/g, "").length - 2;
      lines.forEach((l, i) => {
        const last = i === lines.length - 1;
        const g = last ? gutter(line) : p.paint(`${"+".padStart(width)} |`, "bold", "green");
        out.push(`${g} ${last ? expandTabs(l) : p.paint(expandTabs(l), "green")}`);
      });
      continue;
    }
    if (marks.trim() === "") {
      // Only deletions: nothing to underline, so show the change as a diff (rustc style).
      const w = gutter(line).replace(/\x1b\[[0-9;]*m/g, "").length - 2;
      out.push(`${p.paint(`${String(line).padStart(w)} -`, "bold", "red")} ${p.paint(expandTabs(original), "red")}`);
      out.push(`${p.paint(`${String(line).padStart(w)} +`, "bold", "green")} ${p.paint(expandTabs(patched), "green")}`);
      continue;
    }
    out.push(`${gutter(line)} ${expandTabs(patched)}`);
    out.push(`${empty} ${p.paint(marks.trimEnd(), "green")}`);
  }
  return out;
}

export function renderSummary(bag: { errorCount: number; warningCount: number; omitted?: number }, color: boolean): string {
  const p = new Painter(color);
  const { errorCount: e, warningCount: w } = bag;
  if (e > 0) {
    const more = bag.omitted ? ` (and ${bag.omitted} more not shown; see \`--max-errors\`)` : "";
    const errs = (e === 1 ? "previous error" : `${e} previous errors`) + more;
    const warns = w > 0 ? `; ${w} warning${w === 1 ? "" : "s"} emitted` : "";
    return p.paint("error", "bold", "red") + p.paint(`: aborting due to ${errs}${warns}`, "bold");
  }
  if (w > 0) return p.paint("warning", "bold", "yellow") + p.paint(`: ${w} warning${w === 1 ? "" : "s"} emitted`, "bold");
  return "";
}

export function renderAll(diags: Diagnostic[], opts: RenderOptions): string {
  return diags.map((d) => renderDiagnostic(d, opts)).join("\n\n");
}
