import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENTRY_FILE } from "../src/codegen.ts";
import { compileProject } from "../src/compiler.ts";
import { renderAll } from "../src/diagnostics.ts";

const root = join(import.meta.dir, "..", "examples");
const examples = (await Array.fromAsync(new Bun.Glob("*/expected.txt").scan({ cwd: root }))).map(dirname).sort();

for (const name of examples) {
  test(`example: ${name}`, async () => {
    const srcRoot = join(root, name, "src");
    const paths = await Array.fromAsync(new Bun.Glob("**/*.kl").scan({ cwd: srcRoot }));
    const sources = await Promise.all(paths.map(async (p) => ({ path: p, text: await Bun.file(join(srcRoot, p)).text() })));
    const config = Bun.file(join(root, name, "klass.json"));
    const main = (await config.exists()) ? ((await config.json()).main ?? "Main") : "Main";

    const result = compileProject(sources, { main });
    const errors = result.diagnostics.items.filter((d) => d.severity === "error");
    expect(renderAll(errors, { color: false })).toBe("");

    // Inside the example directory, so bare imports (`lodash`) resolve from the project's node_modules.
    const out = join(root, name, ".test-out");
    await rm(out, { recursive: true, force: true });
    try {
      for (const o of result.outputs) {
        await mkdir(dirname(join(out, o.path)), { recursive: true });
        await Bun.write(join(out, o.path), o.text);
      }
      const proc = Bun.spawn(["bun", join(out, ENTRY_FILE)], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect(stderr).toBe("");
      expect(stdout).toBe(await Bun.file(join(root, name, "expected.txt")).text());
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
}
