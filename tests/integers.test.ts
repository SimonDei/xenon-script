/** `Int`/`UInt` arithmetic wraps to 32 bits (as in C, Java and C#) instead of turning into an inexact `Float`. */
import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENTRY_FILE } from "../src/codegen.ts";
import { compileProject } from "../src/compiler.ts";

const out = join(import.meta.dir, ".integers-out");
afterAll(() => rm(out, { recursive: true, force: true }));

test("+, -, * and negation wrap; compound assignments and ++ too; Float, / and % don't", async () => {
  const text = await Bun.file(join(import.meta.dir, "fixtures", "integers.xn")).text();
  const result = compileProject([{ path: "Main.xn", text }], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  expect(js).toContain("Math.imul(big, big)");
  expect(js).toContain("n = (n + 1) | 0;");
  expect(js).toContain("5 - 8"); // literals whose result fits: as written
  for (const o of result.outputs) {
    await mkdir(dirname(join(out, o.path)), { recursive: true });
    await Bun.write(join(out, o.path), o.text);
  }
  const proc = Bun.spawn(["bun", join(out, ENTRY_FILE)], { stdout: "pipe", stderr: "pipe" });
  const printed = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  expect(printed.trim().split("\n")).toEqual([
    "-2147483648 -2 2147483647 -2147483648",
    "-1757895751 370370367 -2147483648 -3",
    "-2147483648 2147483647 -2147483648 -2147483647",
    "-2147483648 2147483645",
    "4294967295 0",
    "2147483647.5 2.5 1",
  ]);
});
