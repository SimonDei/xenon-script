/** `--bundle`: the compiled `.xn` files as one module; vendor code stays outside. */
import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { bundleOutputs } from "../src/bundle.ts";
import { readAssets, readSources } from "../src/build.ts";
import { compileProject } from "../src/compiler.ts";

const out = join(import.meta.dir, ".bundle-out");
const cli = join(import.meta.dir, "..", "src", "cli.ts");
afterAll(() => rm(out, { recursive: true, force: true }));

test("one module for the program; packages, built-in modules and the source folder's JavaScript stay outside", async () => {
  const src = join(import.meta.dir, "..", "examples", "vendor", "src");
  const result = compileProject(await readSources(src), { main: "Main", typeRoot: src, assets: await readAssets(src), sourceMaps: { sourceRoot: "../src" } });
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const outputs = await bundleOutputs(result.outputs, out, true);
  expect(outputs.map((o) => o.path).sort()).toEqual(["lib/sheet.d.ts", "lib/sheet.js", "xenon-main.js", "xenon-main.js.map"]);

  const bundle = outputs.find((o) => o.path === "xenon-main.js")!.text;
  // Both modules' imports of the library point at its copy next to the bundle.
  expect(bundle).toContain(`import * as Sheet from "./lib/sheet.js";`);
  expect(bundle).toContain(`import { Cell, toCsv } from "./lib/sheet.js";`);
  expect(bundle).toContain("// reports/Totals.js");
  // Prelude classes the program doesn't use are left out (`Exception` stays: checked indexes throw a
  // `RangeException`); interface marks are getters in the class body, so marked classes go too.
  expect(bundle).toContain("class RangeException");
  for (const unused of ["class ArgumentException", "class NotImplementedException", "class Deprecated", "class NoDiscard"]) {
    expect(bundle).not.toContain(unused);
  }
  expect(bundle.trimEnd().endsWith("//# sourceMappingURL=xenon-main.js.map")).toBe(true);
  expect(bundle.split("\n").slice(0, -1).filter((l) => l.trim() === "")).toEqual([]); // no blank lines
  const map = JSON.parse(outputs.find((o) => o.path === "xenon-main.js.map")!.text);
  // The prelude code the bundle keeps (checked indexes, `RangeException`) maps to the prelude, embedded in the map.
  expect([...map.sources].sort()).toEqual(["../src/Main.xn", "../src/reports/Totals.xn", "xenon/Prelude.xn"]);
  expect(map.sourcesContent.every((c: string | null) => c?.includes("class"))).toBe(true);

  for (const o of outputs) await Bun.write(join(out, o.path), o.text);
  const proc = Bun.spawn(["bun", join(out, "xenon-main.js")], { stdout: "pipe", stderr: "pipe" });
  expect(await new Response(proc.stdout).text()).toBe(await Bun.file(join(src, "..", "expected.txt")).text());
  expect(await proc.exited).toBe(0);
});

test("`xenon build --bundle` replaces the modules (stale ones are removed); `--target ts` can't bundle", async () => {
  const project = join(out, "project");
  await rm(project, { recursive: true, force: true });
  await mkdir(join(project, "src", "zoo"), { recursive: true });
  await Bun.write(join(project, "src", "Main.xn"), "import zoo.Lion\nimport _ from 'lodash'\n\npublic class Main {\n  public function Main() { trace(new Lion().roar(), _.sum([1, 2])) }\n}\n");
  await Bun.write(join(project, "src", "zoo", "Lion.xn"), "package zoo {\n  public class Lion {\n    public function roar():String { return 'roar' }\n  }\n}\n");
  const build = async (...flags: string[]) => {
    const proc = Bun.spawn(["bun", cli, "build", "--quiet", "--color", "never", ...flags], { cwd: project, stdout: "pipe", stderr: "pipe" });
    return { code: await proc.exited, stderr: await new Response(proc.stderr).text() };
  };
  expect((await build()).code).toBe(0);
  expect(await Bun.file(join(project, "out", "zoo", "Lion.js")).exists()).toBe(true);

  expect((await build("--bundle")).code).toBe(0);
  expect(await Bun.file(join(project, "out", "zoo", "Lion.js")).exists()).toBe(false);
  const bundle = await Bun.file(join(project, "out", "xenon-main.js")).text();
  expect(bundle).toContain(`import _ from "lodash";`);
  expect(bundle).toContain("class Lion");

  const mixed = await build("--bundle", "--target", "ts");
  expect(mixed.code).toBe(2);
  expect(mixed.stderr).toContain("--bundle writes JavaScript: it can't be combined with --target ts");
});
