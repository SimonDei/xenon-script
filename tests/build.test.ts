/** `klass build` keeps the output directory in sync with the sources. */
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
  await Bun.write(join(dir, "src", "Main.kl"), "package {\n  public class Main {\n    public function Main() { trace('hi') }\n  }\n}\n");
  await Bun.write(join(dir, "src", "util", "Helper.kl"), "package util {\n  public class Helper {}\n}\n");
  await build();
  const out = join(dir, "out");
  expect(await exists(join(out, "util", "Helper.js"))).toBe(true);
  await Bun.write(join(out, "notes.txt"), "hand-written"); // not produced by klass: must survive

  await rm(join(dir, "src", "util"), { recursive: true });
  await build();
  expect(await exists(join(out, "util", "Helper.js"))).toBe(false);
  expect(await exists(join(out, "util"))).toBe(false); // emptied directory removed too
  expect(await exists(join(out, "Main.js"))).toBe(true);
  expect(await exists(join(out, "klass", "Prelude.js"))).toBe(true);
  expect(await exists(join(out, "notes.txt"))).toBe(true);
});
