/** vite-plugin-xenon: Xenon projects built and served by Vite. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build, createServer, type Plugin } from "vite";
import xenon from "../src/index.ts";

const dir = join(import.meta.dir, ".projects");
const app = join(dir, "app");
const write = (path: string, text: string | object) => Bun.write(join(dir, path), typeof text === "string" ? text : JSON.stringify(text));

beforeAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await write("lib/xenon.json", { library: true });
  await write("lib/src/text/Shout.xn", "package text {\n  public class Shout {\n    public static function of(s:String):String => s.toUpperCase() + '!'\n  }\n}\n");
  await write("app/xenon.json", { main: "Main", dependencies: ["../lib"] });
  await write("app/src/Main.xn", `import static text.Shout.of
import { twice } from './util.js'

public class Main {
  public function Main() {
    var g:* = globalThis
    g.xenonResult = of(twice('hi'))
    g.xenonFirst = twice('hi').split('')[0]
  }
}
`);
  await write("app/src/util.js", "export const twice = (s) => s + s;\n");
  await write("app/src/util.d.ts", "export declare const twice: (s: string) => string;\n");
  await write("app/index.html", '<!doctype html>\n<script type="module">import "virtual:xenon";</script>\n');
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("vite build bundles the program, its dependencies, the runtime and JavaScript files", async () => {
  await build({ root: app, configFile: false, logLevel: "silent", plugins: [xenon()], build: { outDir: join(app, "dist"), modulePreload: { polyfill: false } } });
  const assets = [...new Bun.Glob("dist/assets/*.js").scanSync({ cwd: app })];
  expect(assets.length).toBe(1);
  await import(join(app, assets[0]!));
  expect((globalThis as Record<string, unknown>).xenonResult).toBe("HIHI!");
  expect((globalThis as Record<string, unknown>).xenonFirst).toBe("h"); // through a runtime helper (checked index)
});

test("the dev server serves .xn files as modules, the runtime as virtual ones, with source maps", async () => {
  const server = await createServer({ root: app, configFile: false, logLevel: "silent", plugins: [xenon()], server: { middlewareMode: true, hmr: false } });
  try {
    const main = (await server.transformRequest("/src/Main.xn"))!;
    expect(main.code).toContain("globalThis");
    // Its imports point at the library's .xn file, the runtime's virtual module and the JS file.
    expect(main.code).toContain(join(dir, "lib", "src", "text", "Shout.xn"));
    expect(main.code).toContain("/@id/__x00__xenon:xenon/");
    expect(main.code).toContain("/src/util.js");
    // Vite stores map sources relative to the module: the .xn file itself.
    expect((main.map as { sources: string[] }).sources).toEqual(["Main.xn"]);
    const entry = (await server.transformRequest("virtual:xenon"))!;
    expect(entry.code).toContain("new Main()");
  } finally {
    await server.close();
  }
});

test("a compile error is a Vite error with its place; an edit reloads with a fresh compile", async () => {
  const broken = join(app, "src", "Main.xn");
  const good = await Bun.file(broken).text();
  await Bun.write(broken, good.replace("of(twice('hi'))", "of(42)"));
  const plugin = xenon();
  const server = await createServer({ root: app, configFile: false, logLevel: "silent", plugins: [plugin], server: { middlewareMode: true, hmr: false } });
  const sent: unknown[] = [];
  server.ws.send = ((payload: unknown) => void sent.push(payload)) as typeof server.ws.send;
  try {
    const failed = await server.transformRequest("/src/Main.xn").then(() => undefined, (e: Error & { loc?: { line: number } }) => e);
    expect(failed?.message).toContain("[xenon] 1 error");
    expect(failed?.message).toContain("mismatched types");
    expect(failed?.loc?.line).toBe(7);

    await Bun.write(broken, good);
    await (plugin.handleHotUpdate as Exclude<Plugin["handleHotUpdate"], undefined | { handler: unknown }>).call(
      {} as never, { file: broken, server } as never);
    expect(sent).toEqual([{ type: "full-reload" }]);
    expect((await server.transformRequest("/src/Main.xn"))!.code).toContain("twice('hi')");
  } finally {
    await Bun.write(broken, good);
    await server.close();
  }
});
