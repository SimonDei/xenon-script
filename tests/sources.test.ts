/** `"sources"` (further source folders compiled with a program) and `"library": true` (no main class). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { exists, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const dir = join(import.meta.dir, ".sources-projects");
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const lib = join(dir, "lib");
const app = join(dir, "app");

const xenon = async (cwd: string, ...args: string[]) => {
  const proc = Bun.spawn(["bun", cli, ...args, "--color", "never"], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  return { code, out: await new Response(proc.stdout).text(), err: await new Response(proc.stderr).text() };
};

beforeAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(lib, "src", "greet"), { recursive: true });
  await mkdir(join(app, "src"), { recursive: true });
  await Bun.write(join(lib, "xenon.json"), JSON.stringify({ library: true }));
  await Bun.write(join(lib, "src", "greet", "Greeter.xn"), `package greet {
  public class Greeter {
    public static function hello(name:String):String => $'Hello, {name}!'
  }
}
`);
  await Bun.write(join(app, "xenon.json"), JSON.stringify({ main: "Main", sources: ["../lib/src"] }));
  await Bun.write(join(app, "src", "Main.xn"), `import static greet.Greeter.hello

public class Main {
  public function Main() {
    trace(hello('Ada'))
  }
}
`);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("a program compiles a library's folder with its own and runs", async () => {
  const r = await xenon(app, "run");
  expect(r.err).not.toContain("error");
  expect(r.out).toBe("Hello, Ada!\n");
  expect(await exists(join(app, "out", "greet", "Greeter.js"))).toBe(true);
  // The library's map points at its own folder, as seen from the output.
  const map = await Bun.file(join(app, "out", "greet", "Greeter.js.map")).json();
  expect(map.sources).toEqual(["../../../lib/src/greet/Greeter.xn"]);
});

test("messages name a library file by its place on disk", async () => {
  const broken = join(lib, "src", "greet", "Broken.xn");
  await Bun.write(broken, "package greet {\n  public class Broken {\n    public function f():Int => 'x'\n  }\n}\n");
  try {
    const r = await xenon(app, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain(join("..", "lib", "src", "greet", "Broken.xn"));
  } finally {
    await rm(broken);
  }
});

test("a library has no main class: it can be checked and built, not run or bundled", async () => {
  expect((await xenon(lib, "check")).code).toBe(0);
  expect((await xenon(lib, "build")).code).toBe(0);
  expect(await exists(join(lib, "out", "greet", "Greeter.js"))).toBe(true);
  expect(await exists(join(lib, "out", "xenon-main.js"))).toBe(false);
  const run = await xenon(lib, "run");
  expect(run.code).toBe(2);
  expect(run.err).toContain("has no main class to run");
  expect((await xenon(lib, "build", "--bundle")).err).toContain("has no main class to bundle from");
});

test("the same path in two source folders is an error; so is a missing folder", async () => {
  const twin = join(app, "src", "greet", "Greeter.xn");
  await mkdir(join(app, "src", "greet"), { recursive: true });
  await Bun.write(twin, "package greet {\n  public class Greeter {}\n}\n");
  try {
    const r = await xenon(app, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain("`greet/Greeter.xn` is in two source folders");
  } finally {
    await rm(join(app, "src", "greet"), { recursive: true });
  }
  await Bun.write(join(app, "xenon.json"), JSON.stringify({ main: "Main", sources: ["../nope/src"] }));
  try {
    expect((await xenon(app, "check")).err).toContain("source folder not found: ../nope/src");
  } finally {
    await Bun.write(join(app, "xenon.json"), JSON.stringify({ main: "Main", sources: ["../lib/src"] }));
  }
});

test("the editor loads further source folders, points into them and leaves their diagnostics to their own project", async () => {
  const { XenonProject } = await import("../src/service.ts");
  const { locateProject } = await import("../src/lsp.ts");
  const found = locateProject(join(app, "src", "Main.xn"))!;
  expect(found.sources).toEqual([join(lib, "src")]);
  const p = new XenonProject(found.srcRoot, found.main, join(dir, ".ts"), { sources: found.sources });
  await p.load();
  const text = await Bun.file(join(app, "src", "Main.xn")).text();
  expect(p.definition("Main.xn", text.indexOf("hello('Ada')"))[0]?.path).toBe(join(lib, "src", "greet", "Greeter.xn"));
  expect([p.isOwn("Main.xn"), p.isOwn("greet/Greeter.xn")]).toEqual([true, false]);
  expect(p.pathFor(join(lib, "src", "greet", "New.xn"))).toEqual({ path: "greet/New.xn", dir: join(lib, "src") });
  expect(locateProject(join(lib, "src", "greet", "Greeter.xn"))?.library).toBe(true);
});
