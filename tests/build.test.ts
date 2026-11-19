/** `xenon build` keeps the output directory in sync with the sources. */
import { afterAll, expect, test } from "bun:test";
import { exists, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const dir = join(import.meta.dir, ".build-project");
const cli = join(import.meta.dir, "..", "src", "cli.ts");
afterAll(() => rm(dir, { recursive: true, force: true }));

const build = async () => {
  const proc = Bun.spawn(["bun", cli, "build", "--quiet"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
};

test("build removes outputs the previous build produced but this one doesn't", async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "src", "util"), { recursive: true });
  await Bun.write(join(dir, "src", "Main.xn"), "package {\n  public class Main {\n    public function Main() { trace('hi') }\n  }\n}\n");
  await Bun.write(join(dir, "src", "util", "Helper.xn"), "package util {\n  public class Helper {}\n}\n");
  await build();
  const out = join(dir, "out");
  expect(await exists(join(out, "util", "Helper.js"))).toBe(true);
  await Bun.write(join(out, "notes.txt"), "hand-written"); // not produced by xenon: must survive

  await rm(join(dir, "src", "util"), { recursive: true });
  await build();
  expect(await exists(join(out, "util", "Helper.js"))).toBe(false);
  expect(await exists(join(out, "util"))).toBe(false); // emptied directory removed too
  expect(await exists(join(out, "Main.js"))).toBe(true);
  expect(await exists(join(out, "xenon", "Prelude.js"))).toBe(true);
  expect(await exists(join(out, "notes.txt"))).toBe(true);
});

test("--project takes a project folder; --src pointing at one says to use --project", async () => {
  const project = join(dir, "app");
  await rm(project, { recursive: true, force: true });
  await mkdir(join(project, "code"), { recursive: true });
  await Bun.write(join(project, "xenon.json"), JSON.stringify({ src: "code", out: "dist" }));
  await Bun.write(join(project, "code", "Main.xn"), "package {\n  public class Main {\n    public function Main() { trace('hi') }\n  }\n}\n");

  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", cli, "run", "--quiet", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    return { code: await proc.exited, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
  };
  // The folder's xenon.json is read, and its paths are relative to the folder.
  expect(await run("--project", "app")).toMatchObject({ code: 0, stdout: "hi\n" });
  expect(await exists(join(project, "dist", "Main.js"))).toBe(true);

  const mixup = await run("--src", "app");
  expect(mixup.code).toBe(2);
  expect(mixup.stderr).toStartWith("error: `app` is a project folder (it has a xenon.json), not a source root: use `--project app`");
});
