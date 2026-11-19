/** Plain JavaScript can import, use and subclass compiled Xenon classes. */
import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compileProject } from "../src/compiler.ts";

test("JS consumes compiled Xenon classes", async () => {
  const srcRoot = join(import.meta.dir, "..", "examples", "zoo", "src");
  const paths = await Array.fromAsync(new Bun.Glob("**/*.xn").scan({ cwd: srcRoot }));
  const sources = await Promise.all(paths.map(async (p) => ({ path: p, text: await Bun.file(join(srcRoot, p)).text() })));
  const result = compileProject(sources, { main: "Main" });
  expect(result.diagnostics.hasErrors).toBe(false);

  const out = join(import.meta.dir, "..", "examples", "zoo", ".test-out-js");
  await rm(out, { recursive: true, force: true });
  try {
    for (const o of result.outputs) {
      await mkdir(dirname(join(out, o.path)), { recursive: true });
      await Bun.write(join(out, o.path), o.text);
    }
    await Bun.write(
      join(out, "consumer.mjs"),
      `import { Animal } from './com/zoo/Animal.js';
import { Food } from './com/zoo/food/Food.js';

class Parrot extends Animal {
  speak() { return this.name + ' says hello'; }
}

const p = new Parrot('Polly');
p.feed(new Food('seeds', 40));
console.log(p.speak(), p.calories, p instanceof Animal, Animal.population);
`,
    );
    const proc = Bun.spawn(["bun", join(out, "consumer.mjs")], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(stderr).toBe("");
    expect(stdout).toBe("Polly says hello 40 true 1\n");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
