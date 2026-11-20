/** `"globals"`: packages the page loads with `<script>` tags are read from globals instead of imported. */
import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bundleOutputs } from "../src/bundle.ts";
import { compileProject } from "../src/compiler.ts";

const sources = [{ path: "Main.xn", text: `import zip from 'pizzip-like'
import * as tmpl from 'templates-like'
import { render, VERSION as version } from 'templates-like'
import 'side-effect-only'

public class Main {
  public function Main() {
    trace(zip.name, tmpl.kind, render('x'), version)
  }
}
` }];
const globals = { "pizzip-like": "PizZip", "templates-like": "window.templates", "side-effect-only": "Nothing" };

test("imports of packages listed in globals read the globals (and fail clearly when one is missing)", async () => {
  const result = compileProject(sources, { main: "Main", globals });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  expect(js).not.toContain(" from '");
  expect(js).toContain("const zip = globalThis.PizZip ?? (() => { throw new ReferenceError(");
  expect(js).toContain("const tmpl = globalThis.window?.templates ?? ");
  expect(js).toContain("const { render, VERSION: version } = globalThis.window?.templates ?? ");
  expect(js).toContain("// 'side-effect-only' is loaded by the page (`Nothing`)");

  const out = join(import.meta.dir, ".globals-out");
  await rm(out, { recursive: true, force: true });
  try {
    for (const o of result.outputs) {
      await mkdir(dirname(join(out, o.path)), { recursive: true });
      await Bun.write(join(out, o.path), o.text);
    }
    await Bun.write(join(out, "page.mjs"), `globalThis.PizZip = { name: 'zip' };
globalThis.window = { templates: { kind: 'tmpl', VERSION: 3, render: (s) => '<' + s + '>' } };
await import('./Main.js').then((m) => new m.Main());
`);
    await Bun.write(join(out, "missing.mjs"), "try { await import('./Main.js'); } catch (e) { console.log(e.name + ': ' + e.message); }\n");
    const run = async (file: string) => {
      const proc = Bun.spawn(["bun", join(out, file)], { stdout: "pipe", stderr: "pipe" });
      return (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    };
    expect(await run("page.mjs")).toBe("zip tmpl <x> 3\n");
    expect(await run("missing.mjs")).toBe("ReferenceError: `PizZip` (the package 'pizzip-like') is not loaded: add its <script> tag before this one\n");

    // The bundle has no import of them either.
    const bundled = await bundleOutputs(result.outputs, out, false);
    const bundle = bundled.find((o) => o.path === "xenon-main.js")!.text;
    expect(bundle).not.toMatch(/from ['"](pizzip-like|templates-like|side-effect-only)['"]/);
    expect(bundle).toContain("globalThis.PizZip");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("the TypeScript output keeps the imports (for the packages' types)", () => {
  const ts = compileProject(sources, { main: "Main", globals, target: "ts" });
  expect(ts.outputs.find((o) => o.path === "Main.ts")!.text).toContain("import zip from 'pizzip-like';");
});
