import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENTRY_FILE } from "../src/codegen.ts";
import { readAssets } from "../src/build.ts";
import { bundleOutputs } from "../src/bundle.ts";
import { compileProject } from "../src/compiler.ts";
import { renderAll } from "../src/diagnostics.ts";

const root = join(import.meta.dir, "..", "examples");
const examples = (await Array.fromAsync(new Bun.Glob("*/expected.txt").scan({ cwd: root }))).map(dirname).sort();

for (const name of examples) {
  test(`example: ${name}`, async () => {
    const srcRoot = join(root, name, "src");
    const paths = await Array.fromAsync(new Bun.Glob("**/*.xn").scan({ cwd: srcRoot }));
    const sources = await Promise.all(paths.map(async (p) => ({ path: p, text: await Bun.file(join(srcRoot, p)).text() })));
    const config = Bun.file(join(root, name, "xenon.json"));
    const project: { main?: string; bundle?: boolean; nullSafety?: boolean } = (await config.exists()) ? await config.json() : {};
    const main = project.main ?? "Main";

    // As `xenon build` compiles: JavaScript imports typed from their `.d.ts` files, JavaScript
    // files of the source folder copied along.
    const result = compileProject(sources, { main, typeRoot: srcRoot, assets: await readAssets(srcRoot), nullSafety: !!project.nullSafety });
    const errors = result.diagnostics.items.filter((d) => d.severity === "error");
    expect(renderAll(errors, { color: false })).toBe("");
    expect(renderAll(result.declarationErrors, { color: false })).toBe("");

    // Inside the example directory, so bare imports (`lodash`) resolve from the project's node_modules.
    const out = join(root, name, ".test-out");
    await rm(out, { recursive: true, force: true });
    try {
      let outputs = result.outputs;
      if (project.bundle) {
        // As `xenon build` with `"bundle": true`: one module, the copied JavaScript files beside it.
        await mkdir(out, { recursive: true });
        outputs = await bundleOutputs(outputs, out, false);
        expect(outputs.filter((o) => !o.asset).map((o) => o.path)).toEqual([ENTRY_FILE]);
      }
      for (const o of outputs) {
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
