/** Checked positions: `a[i]` on arrays, tuples and strings throws a `RangeException` when `i` is out of range. */
import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENTRY_FILE } from "../src/codegen.ts";
import { compileProject } from "../src/compiler.ts";

const out = join(import.meta.dir, ".indexes-out");
afterAll(() => rm(out, { recursive: true, force: true }));

const MAIN = await Bun.file(join(import.meta.dir, "fixtures", "indexes.xn")).text();

test("reads out of range throw; plain writes grow; at() gives null; a tuple's own positions aren't checked", async () => {
  const result = compileProject([{ path: "Main.xn", text: MAIN }], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  expect(js).toContain("list[$index(list, 1)]");
  expect(js).toContain("list[5] = 9;");                      // a plain write: unchecked
  expect(js).toContain("list[$index(list, 0)] = (list[0] + 10) | 0;"); // read and written: checked (and an `Int`: wrapped)
  expect(js).toContain("pair[1]");                          // a tuple's constant position
  for (const o of result.outputs) {
    await mkdir(dirname(join(out, o.path)), { recursive: true });
    await Bun.write(join(out, o.path), o.text);
  }
  const proc = Bun.spawn(["bun", join(out, ENTRY_FILE)], { stdout: "pipe", stderr: "pipe" });
  const printed = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  expect(printed.trim().split("\n")).toEqual([
    "2 c",
    "11,3,,,,9",
    "1",
    "-1",
    "caught: index 10 is out of range (length 6)",
    "caught: index -1 is out of range (length 3)",
    "caught: index 1 is out of range (length 1)",
  ]);
});
