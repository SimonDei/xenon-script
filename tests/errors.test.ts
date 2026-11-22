/**
 * Diagnostic snapshot tests. Two kinds of cases in `tests/errors/`:
 * - `<name>.xn`: a single file compiled as `Main.xn` (top-level package);
 * - `<name>/`: a directory used as the source root of a multi-file project (main class `Main`).
 * The rendered diagnostics must equal `<name>.stderr`. Run with UPDATE=1 to (re)write snapshots.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { compileProject, type SourceInput } from "../src/compiler.ts";
import { renderAll } from "../src/diagnostics.ts";

const dir = join(import.meta.dir, "errors");
const singles = (await Array.fromAsync(new Bun.Glob("*.xn").scan({ cwd: dir }))).map((f) => f.replace(/\.xn$/, ""));
const projects = [...new Set((await Array.fromAsync(new Bun.Glob("*/**/*.xn").scan({ cwd: dir }))).map((f) => f.split("/")[0]!))];

async function load(name: string): Promise<{ sources: SourceInput[]; display: (path: string) => string }> {
  if (singles.includes(name)) {
    const text = await Bun.file(join(dir, `${name}.xn`)).text();
    return { sources: [{ path: "Main.xn", text }], display: () => `${name}.xn` };
  }
  const root = join(dir, name);
  const paths = (await Array.fromAsync(new Bun.Glob("**/*.xn").scan({ cwd: root }))).sort();
  const sources = await Promise.all(paths.map(async (p) => ({ path: p, text: await Bun.file(join(root, p)).text() })));
  return { sources, display: (path) => `${name}/${path}` };
}

for (const name of [...singles, ...projects].sort()) {
  test(`diagnostics: ${name}`, async () => {
    const { sources, display } = await load(name);
    // A project case may carry a `xenon.json` (`{ "nullSafety": true }`).
    const config = Bun.file(join(dir, name, "xenon.json"));
    const project: { nullSafety?: boolean } = !singles.includes(name) && (await config.exists()) ? await config.json() : {};
    const result = compileProject(sources, { main: "Main", nullSafety: project.nullSafety });
    // Unused-variable/member warnings would drown most cases; only `unused*` cases show them.
    const shown = result.diagnostics.sorted().filter((d) => name.startsWith("unused") || !["X0861", "X0862"].includes(d.code ?? ""));
    const rendered = renderAll(shown, { color: false, displayPath: (f) => (f.prelude ? `<xenon prelude>/${f.path}` : display(f.path)) }) + "\n";
    const snapshot = join(dir, `${name}.stderr`);
    if (process.env.UPDATE || !(await Bun.file(snapshot).exists())) await Bun.write(snapshot, rendered);
    expect(rendered).toBe(await Bun.file(snapshot).text());
  });
}
