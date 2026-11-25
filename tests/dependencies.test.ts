/** `"dependencies"`: other Xenon projects (folders or npm packages) compiled with a program. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveDependencies } from "../src/project.ts";

const dir = join(import.meta.dir, ".dependencies-projects");
const cli = join(import.meta.dir, "..", "src", "cli.ts");

const write = (path: string, text: string | object) => Bun.write(join(dir, path), typeof text === "string" ? text : JSON.stringify(text));
const xenon = async (project: string, ...args: string[]) => {
  const proc = Bun.spawn(["bun", cli, ...args, "--color", "never"], { cwd: join(dir, project), stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  return { code, out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text() };
};

beforeAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // base ← ui ← app (ui by folder), and an npm-installed `fmt` package used by ui.
  await write("base/xenon.json", { library: true, semicolons: "never", globals: { pizzip: "PizZip" } });
  await write("base/src/base/Text.xn", "package base {\n  public class Text {\n    public static function shout(s:String):String => s.toUpperCase() + '!'\n  }\n}\n");
  await write("ui/xenon.json", { library: true, dependencies: ["../base", "fmt"] });
  await write("ui/src/ui/Label.xn", `package ui {
  import base.Text
  import fmt.Pad

  public class Label {
    public static function of(s:String):String {
      var unused = 1
      return Pad.around(Text.shout(s))
    }
  }
}
`);
  await write("node_modules/fmt/xenon.json", { library: true, src: "lib" });
  await write("node_modules/fmt/lib/fmt/Pad.xn", "package fmt {\n  public class Pad {\n    public static function around(s:String):String => $'[{s}]'\n  }\n}\n");
  await write("app/xenon.json", { main: "Main", semicolons: "always", dependencies: ["../ui"] });
  await write("app/src/Main.xn", "import ui.Label;\n\npublic class Main {\n  public function Main() {\n    trace(Label.of('hi'));\n  }\n}\n");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("dependencies are found by folder and in node_modules, with theirs, each once", () => {
  const deps = resolveDependencies(join(dir, "app"), ["../ui"], { nullSafety: true });
  expect(deps.map((d) => [d.name, d.src.slice(dir.length + 1)])).toEqual([
    ["../ui", "ui/src"],
    ["../base", "base/src"],
    ["fmt", "node_modules/fmt/lib"],
  ]);
  expect(deps.find((d) => d.name === "../base")!.globals).toEqual({ pizzip: "PizZip" });
});

test("a program builds and runs with its dependencies; their warnings and style stay theirs", async () => {
  // `ui` has an unused variable and `base` omits semicolons: neither is the app's problem.
  const r = await xenon("app", "run", "--deny-warnings");
  expect(r.err).not.toContain("warning");
  expect(r.out).toBe("[HI!]\n");
});

test("missing dependencies, cycles, different null safety and clashing globals are reported", async () => {
  expect(() => resolveDependencies(join(dir, "app"), ["../nope"], { nullSafety: true })).toThrow("dependency not found: ../nope");
  expect(() => resolveDependencies(join(dir, "app"), ["left-pad"], { nullSafety: true })).toThrow("no node_modules/left-pad/xenon.json");

  await write("cycle-a/xenon.json", { library: true, dependencies: ["../cycle-b"] });
  await write("cycle-b/xenon.json", { library: true, dependencies: ["../cycle-a"] });
  expect(() => resolveDependencies(join(dir, "app"), ["../cycle-a"], { nullSafety: true })).toThrow("dependency cycle");

  expect(() => resolveDependencies(join(dir, "app"), ["../ui"], { nullSafety: false })).toThrow("null safety");
  expect(() => resolveDependencies(join(dir, "app"), ["../ui"], { nullSafety: true, globals: { pizzip: "Zip" } }))
    .toThrow('"globals": pizzip is `Zip` in this project but `PizZip` in ../base');

  await write("broken/xenon.json", { main: "Main", dependencies: ["../nope"] });
  const r = await xenon("broken", "check");
  expect(r.code).toBe(2);
  expect(r.err).toContain("dependency not found: ../nope");
});
