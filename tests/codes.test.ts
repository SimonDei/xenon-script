import { expect, test } from "bun:test";
import { join } from "node:path";
import { CODES, explain } from "../src/codes.ts";

const srcDir = join(import.meta.dir, "..", "src");

test("every emitted diagnostic code is in the catalog", async () => {
  const files = await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: srcDir }));
  const used = new Set<string>();
  for (const f of files) {
    if (f === "codes.ts") continue;
    for (const m of (await Bun.file(join(srcDir, f)).text()).matchAll(/"(K\d{4})"/g)) used.add(m[1]!);
  }
  const missing = [...used].filter((c) => !CODES[c]).sort();
  expect(missing).toEqual([]);
  // and the catalog has no stale entries
  const stale = Object.keys(CODES).filter((c) => !used.has(c)).sort();
  expect(stale).toEqual([]);
});

test("explain renders title, text and example", () => {
  const text = explain("k0308")!;
  expect(text).toStartWith("K0308: mismatched types\n");
  expect(text).toContain("Example:");
  expect(text).toContain("int(total / 2)");
  expect(explain("K9999")).toBeUndefined();
});
