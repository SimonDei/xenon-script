/** `"semicolons": "always" | "never" | "any"` (xenon.json) and `--semicolons`: the project's statement endings. */
import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";

const code = `import { readFileSync } from 'node:fs'

public class Main {
  private var count:Int = 0
  private var name:String = 'x';

  public function Main() {
    var a = 1
    var b = 2; var c = 3;
    if (a > 0) {
      trace(a, b, c, readFileSync, count, name)
    }
    do { a++ } while (a < 3)
  }
}
`;

/** `code line:col` of the semicolon warnings, and the fix-its' edits applied to the text. */
function check(semicolons?: "always" | "never" | "any") {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", ...(semicolons ? { semicolons } : {}) });
  const found = result.diagnostics.sorted().filter((d) => d.code === "X0884" || d.code === "X0885");
  const where = found.map((d) => {
    const l = d.labels.find((x) => x.primary)!;
    const p = l.span.file.position(l.span.start);
    return `${d.code} ${p.line}:${p.col}`;
  });
  // Apply every fix-it, last first, so the positions stay valid.
  const edits = found.flatMap((d) => d.help.flatMap((h) => h.edits ?? [])).sort((x, y) => y.span.start - x.span.start);
  let fixed = code;
  for (const e of edits) fixed = fixed.slice(0, e.span.start) + e.text + fixed.slice(e.span.end);
  return { where, fixed, errors: result.diagnostics.items.filter((d) => d.severity === "error") };
}

test("`always` makes a statement ended by a line break, `}` or the end an error; the fix adds the `;`", () => {
  const { where, fixed, errors } = check("always");
  expect(errors.map((d) => d.code)).toEqual(Array(6).fill("X0884"));
  expect(where).toEqual(["X0884 1:39", "X0884 4:28", "X0884 8:14", "X0884 11:48", "X0884 13:13", "X0884 13:29"]);
  expect(fixed).toContain("import { readFileSync } from 'node:fs';\n");
  expect(fixed).toContain("    do { a++; } while (a < 3);\n");
  // Fixed, the file has nothing left to report.
  expect(compileProject([{ path: "Main.xn", text: fixed }], { main: "Main", semicolons: "always" }).diagnostics.items.filter((d) => d.code === "X0884")).toEqual([]);
});

test("`never` makes a `;` a line break would replace an error, not one between statements on a line", () => {
  const { where, fixed, errors } = check("never");
  expect(errors.map((d) => d.code)).toEqual(["X0885", "X0885"]);
  expect(where).toEqual(["X0885 5:32", "X0885 9:25"]);
  expect(fixed).toContain("private var name:String = 'x'\n");
  expect(fixed).toContain("var b = 2; var c = 3\n");
});

test("`any` (the default) accepts both", () => {
  expect(check("any").where).toEqual([]);
  expect(check().where).toEqual([]);
});

const dir = join(import.meta.dir, ".semicolons-project");
const cli = join(import.meta.dir, "..", "src", "cli.ts");
afterAll(() => rm(dir, { recursive: true, force: true }));

test("xenon.json's \"semicolons\" and --semicolons (the flag wins); other values are a usage error", async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "src"), { recursive: true });
  await Bun.write(join(dir, "src", "Main.xn"), "public class Main {\n  public function Main() { trace('hi') }\n}\n");
  const build = async (config: object, ...args: string[]) => {
    await Bun.write(join(dir, "xenon.json"), JSON.stringify({ main: "Main", ...config }));
    const proc = Bun.spawn(["bun", cli, "build", "--quiet", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    return { code: await proc.exited, stderr: await new Response(proc.stderr).text() };
  };
  expect((await build({ semicolons: "always" })).stderr).toContain("X0884");
  expect((await build({})).stderr).not.toContain("X0884");
  expect((await build({}, "--semicolons", "always")).stderr).toContain("X0884");
  expect((await build({ semicolons: "always" }, "--semicolons", "any")).stderr).not.toContain("X0884");
  const bad = await build({ semicolons: "sometimes" });
  expect(bad.code).toBe(2);
  expect(bad.stderr).toContain('"semicolons" in xenon.json must be always, never or any');
});
