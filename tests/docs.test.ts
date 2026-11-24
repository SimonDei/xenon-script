/**
 * The book's examples (doc/*.md) compile, report exactly the errors they say, and print what they say.
 *
 * Only code blocks marked ```` ```actionscript check ```` are checked:
 * - A block with a top-level declaration (`class`, `interface`, `enum`, `typedef`, `import`, `package`)
 *   is a file `Main.xn`; `public class Main { public function Main() {} }` is added when it has none.
 *   Any other block is a list of statements, run in `Main`'s constructor.
 * - `// file: shop/Cart.xn` lines split a block into several files (the first part is `Main.xn`).
 * - A line ending in `// error X0501` (or `// warning X0889`, also followed by `: text`) must get a
 *   diagnostic with that code; every other line must get none (unused-variable warnings aside).
 * - A block followed by ```` ```text output ```` is run with Bun, and must print exactly that text.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENTRY_FILE } from "../src/codegen.ts";
import { compileProject } from "../src/compiler.ts";

const docDir = join(import.meta.dir, "..", "doc");
/** Inside the repository, so JavaScript imports (`node:fs`, …) are typed from `node_modules`. */
const typeRoot = join(import.meta.dir, ".docs-project", "src");
const outRoot = join(import.meta.dir, ".docs-out");
afterAll(() => rm(outRoot, { recursive: true, force: true }));

interface Example {
  doc: string;
  line: number;
  code: string;
  output?: string;
}

function examples(doc: string, text: string): Example[] {
  const found: Example[] = [];
  const fence = /^```(\S*)([^\n]*)\n([\s\S]*?)^```$/gm;
  let m: RegExpExecArray | null;
  let last: Example | undefined;
  let lastEnd = -1;
  while ((m = fence.exec(text))) {
    const [, lang, info, body] = m;
    const line = text.slice(0, m.index).split("\n").length;
    if (lang === "text" && info!.trim() === "output" && last && text.slice(lastEnd, m.index).trim() === "") {
      last.output = body!;
      continue;
    }
    if (lang === "actionscript" && info!.trim() === "check") {
      last = { doc, line, code: body! };
      lastEnd = m.index + m[0].length;
      found.push(last);
    } else last = undefined;
  }
  return found;
}

const DECLARATION = /^(?:\s*(?:public |internal |final |abstract |static |dynamic |native(?:\('[^']*'\))? )*(?:class|interface|enum|typedef)\b|import |package\b|\[)/m;

/** The example as source files, and how its lines map back (file → line offset in the block). */
function sources(code: string): { files: { path: string; text: string; offset: number }[] } {
  const parts: { path: string; lines: string[]; offset: number }[] = [{ path: "Main.xn", lines: [], offset: 0 }];
  code.split("\n").forEach((l, i) => {
    const file = /^\/\/ file: (\S+)\s*$/.exec(l);
    if (file) parts.push({ path: file[1]!, lines: [], offset: i + 1 });
    else parts.at(-1)!.lines.push(l);
  });
  const files = parts.filter((p) => p.lines.some((l) => l.trim())).map((p) => ({ path: p.path, text: p.lines.join("\n"), offset: p.offset }));
  const main = files.find((f) => f.path === "Main.xn");
  if (main && !DECLARATION.test(main.text)) {
    // Statements: the body of `Main`'s constructor (2 lines above them).
    main.text = `public class Main {\n  public function Main() {\n${main.text}\n  }\n}\n`;
    main.offset -= 2;
  } else if (main && !/\bclass Main\b/.test(main.text)) {
    main.text += "\n\npublic class Main { public function Main() {} }\n";
  } else if (!main) {
    files.unshift({ path: "Main.xn", text: "public class Main { public function Main() {} }\n", offset: 0 });
  }
  return { files };
}

const all = (await Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: docDir }))).sort();
const cases = (await Promise.all(all.map(async (f) => examples(f, await Bun.file(join(docDir, f)).text())))).flat();

test("the book has checked examples", () => {
  expect(cases.length).toBeGreaterThan(0);
});

for (const ex of cases) {
  test(`${ex.doc}:${ex.line}`, async () => {
    const { files } = sources(ex.code);
    const result = compileProject(files.map((f) => ({ path: f.path, text: f.text })), { main: "Main", typeRoot });
    // Expected diagnostics, by block line (1-based, below the fence).
    const expected = new Map<number, string[]>();
    ex.code.split("\n").forEach((l, i) => {
      const codes = [...l.matchAll(/\/\/.*?\b(?:error|warning) (X\d{4})/g)].map((c) => c[1]!);
      if (codes.length) expected.set(i + 1, codes);
    });
    const got = new Map<number, string[]>();
    const problems: string[] = [];
    for (const d of result.diagnostics.items) {
      if (d.code === "X0861" || d.code === "X0862") continue;
      const label = d.labels.find((l) => l.primary) ?? d.labels[0];
      const file = label && files.find((f) => f.path === label.span.file.path);
      if (!label || !file) {
        problems.push(`${d.code} ${d.message} (no position in the example)`);
        continue;
      }
      const line = label.span.file.position(label.span.start).line + file.offset;
      got.set(line, [...(got.get(line) ?? []), d.code ?? "?"]);
      if (!expected.get(line)?.includes(d.code ?? "")) problems.push(`line ${line}: unexpected ${d.code} ${d.message}`);
    }
    for (const [line, codes] of expected) {
      for (const c of codes) if (!got.get(line)?.includes(c)) problems.push(`line ${line}: expected ${c}, got ${got.get(line)?.join(", ") || "nothing"}`);
    }
    expect(problems).toEqual([]);

    if (ex.output !== undefined) {
      const out = join(outRoot, `${ex.doc.replace(/\.md$/, "")}-${ex.line}`);
      await rm(out, { recursive: true, force: true });
      for (const o of result.outputs) {
        await mkdir(dirname(join(out, o.path)), { recursive: true });
        await Bun.write(join(out, o.path), o.text);
      }
      const proc = Bun.spawn(["bun", join(out, ENTRY_FILE)], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(stderr).toBe("");
      expect(stdout).toBe(ex.output);
    }
  });
}
