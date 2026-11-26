/**
 * Vite plugin for XenonScript: `.xn` files are modules Vite can import, serve and bundle.
 *
 *     // vite.config.ts
 *     import xenon from "vite-plugin-xenon";
 *     export default { plugins: [xenon()] };
 *
 *     <!-- index.html: starts the program (`new Main()`, the main class of xenon.json) -->
 *     <script type="module">import "virtual:xenon";</script>
 *
 * Xenon checks a project as a whole, so the plugin compiles the project of `xenon.json` (with its
 * `"dependencies"`) at once, caches the result until a `.xn` file changes, and serves each file's
 * module from it. Compiled modules import each other by their output paths (`./ui/H.js`); the
 * plugin points those imports back at the `.xn` files, and at virtual modules for the runtime
 * (`xenon/Prelude.js`). JavaScript files next to the sources and npm packages are resolved by Vite
 * as usual. A compile error is a Vite error (the overlay in development); a change to a `.xn` file
 * reloads the page (custom elements, for one, can't be defined twice).
 *
 * The compiler uses Bun's APIs: run Vite with Bun (`bunx --bun vite`).
 */
import { existsSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { compileOptions, type Config, ProjectError, readProjectFiles, readProjectJson, resolveConfig, sourceRoots } from "../../../src/build.ts";
import { entryFile, type OutputFile } from "../../../src/codegen.ts";
import { compileProject, type CompileResult } from "../../../src/compiler.ts";
import { renderAll } from "../../../src/diagnostics.ts";

export interface XenonOptions {
  /** The project: a folder with a `xenon.json`, or the file itself (default: Vite's root). */
  project?: string;
}

/** What `import "virtual:xenon"` resolves to: the module that starts the program. */
const MAIN = "virtual:xenon";
/** Modules the compiler generates without a `.xn` file of their own (the runtime, the entry), by output path. */
const VIRTUAL = "\0xenon:";

interface Compiled {
  result: CompileResult;
  /** Output modules by path (`ui/H.js`). */
  byPath: Map<string, OutputFile>;
  /** Absolute `.xn` path → output path, and back. */
  outOf: Map<string, string>;
  sourceOf: Map<string, string>;
}

export default function xenon(options: XenonOptions = {}): Plugin {
  let vite: ResolvedConfig;
  let server: ViteDevServer | undefined;
  let projectPath = "";
  let root = "";
  let config: Config | undefined;
  let compiled: Promise<Compiled> | undefined;

  const loadConfig = async () => {
    const given = resolve(vite.root, options.project ?? ".");
    projectPath = given.endsWith(".json") ? given : join(given, "xenon.json");
    root = dirname(projectPath);
    try {
      const json = await readProjectJson(projectPath);
      if (!json) throw new ProjectError(`no xenon.json in ${relative(process.cwd(), root) || "."}`);
      // Vite bundles: the modules stay modules; maps go to Vite with absolute source paths.
      config = await resolveConfig(json, root, projectPath, { bundle: false, target: "js", sourceMaps: true });
    } catch (e) {
      config = undefined;
      throw e instanceof ProjectError ? new Error(`[xenon] ${e.message}`) : e;
    }
  };

  const absolute = (file: { path: string; root?: { dir: string } }) => join(file.root?.dir ?? resolve(root, config!.src), file.path);

  const compile = (): Promise<Compiled> => (compiled ??= (async () => {
    if (!config) await loadConfig();
    const sources = await readProjectFiles(config!, root);
    const result = compileProject(sources, compileOptions(config!, root));
    const byPath = new Map<string, OutputFile>();
    const outOf = new Map<string, string>();
    const sourceOf = new Map<string, string>();
    for (const o of result.outputs) {
      byPath.set(o.path, o);
      if (o.source && !o.source.prelude && !o.path.endsWith(".map")) {
        outOf.set(absolute(o.source), o.path);
        sourceOf.set(o.path, absolute(o.source));
      }
    }
    return { result, byPath, outOf, sourceOf };
  })());

  /** A compile error as a Vite error: the rendered diagnostics, located at the first error. */
  const failure = (result: CompileResult): Error => {
    const errors = result.diagnostics.sorted().filter((d) => d.severity === "error");
    const message = renderAll(errors, { color: false, displayPath: (f) => (f.prelude ? `<xenon prelude>/${f.path}` : relative(process.cwd(), absolute(f))) });
    const err = new Error(`[xenon] ${errors.length} error${errors.length === 1 ? "" : "s"}\n\n${message}`) as Error & { id?: string; loc?: { file: string; line: number; column: number } };
    const span = errors[0]?.labels.find((l) => l.primary)?.span;
    if (span && !span.file.prelude) {
      const p = span.file.position(span.start);
      err.id = absolute(span.file);
      err.loc = { file: err.id, line: p.line, column: p.col - 1 };
    }
    return err;
  };

  /** A module and its map, with the map's source as an absolute path (Vite resolves it from there). */
  const moduleOf = (c: Compiled, path: string) => {
    const out = c.byPath.get(path)!;
    const code = out.text.replace(/\/\/# sourceMappingURL=.*\n?$/, "");
    const mapFile = c.byPath.get(`${path}.map`);
    if (!mapFile) return { code, map: null };
    const map = JSON.parse(mapFile.text) as { version: number; sources: string[]; mappings: string; names: string[] };
    if (out.source && !out.source.prelude) map.sources = [absolute(out.source)];
    return { code, map };
  };

  /** The output path of a module the plugin serves: a `.xn` file or a virtual module. */
  const outputPathOf = (c: Compiled, id: string) => (id.startsWith(VIRTUAL) ? id.slice(VIRTUAL.length) : c.outOf.get(id.split("?")[0]!));

  return {
    name: "xenon",
    enforce: "pre",

    async configResolved(resolved) {
      vite = resolved;
      await loadConfig();
    },

    configureServer(s) {
      server = s;
      // The project file and source folders outside Vite's root (dependencies) are watched too.
      s.watcher.add([projectPath, ...sourceRoots(config!, root)]);
      // A new or deleted .xn file changes the project too (edits arrive through `handleHotUpdate`).
      const changed = (file: string) => {
        if (!file.endsWith(".xn")) return;
        compiled = undefined;
        s.ws.send({ type: "full-reload" });
      };
      s.watcher.on("add", changed);
      s.watcher.on("unlink", changed);
    },

    async buildStart() {
      const c = await compile();
      for (const id of c.outOf.keys()) this.addWatchFile(id);
      for (const d of c.result.diagnostics.items) {
        if (d.severity === "warning" && !d.labels.find((l) => l.primary)?.span.file.root) this.warn(`${d.code}: ${d.message}`);
      }
    },

    async resolveId(id, importer) {
      if (id === MAIN) {
        if (config?.library) this.error(`[xenon] ${relative(process.cwd(), projectPath)} is a library ("library": true): it has no main class to start`);
        return VIRTUAL + entryFile("js");
      }
      if (!importer || !(importer.endsWith(".xn") || importer.startsWith(VIRTUAL)) || !id.startsWith(".")) return null;
      const c = await compile();
      const from = outputPathOf(c, importer);
      if (from === undefined) return null;
      const path = posix.normalize(posix.join(posix.dirname(from), id));
      const source = c.sourceOf.get(path);
      if (source) return source;
      if (c.byPath.has(path)) return VIRTUAL + path;
      // A JavaScript file of one of the source folders (copied next to the modules by `xenon build`).
      for (const dir of sourceRoots(config!, root)) {
        if (existsSync(join(dir, path))) return join(dir, path);
      }
      return null;
    },

    async load(id) {
      if (!id.startsWith(VIRTUAL) && !id.split("?")[0]!.endsWith(".xn")) return null;
      const c = await compile();
      if (c.result.diagnostics.hasErrors) throw failure(c.result);
      const path = outputPathOf(c, id);
      if (path === undefined || !c.byPath.has(path)) {
        // A .xn file outside the project's source folders.
        this.error(`[xenon] ${relative(process.cwd(), id)} isn't in the project's source folders (${sourceRoots(config!, root).map((d) => relative(process.cwd(), d) || ".").join(", ")})`);
      }
      return moduleOf(c, path);
    },

    async handleHotUpdate({ file }) {
      const isProject = file === projectPath;
      if (!isProject && !file.endsWith(".xn")) return;
      if (!isProject && !sourceRoots(config!, root).some((dir) => !relative(dir, file).startsWith(".."))) return;
      compiled = undefined;
      if (isProject) await loadConfig().catch((e) => server?.config.logger.error((e as Error).message));
      // Xenon modules can't be swapped one by one (a change may alter others; custom elements
      // can't be defined twice): drop them all and reload the page.
      for (const mod of server?.moduleGraph.idToModuleMap.values() ?? []) {
        if (mod.id && (mod.id.endsWith(".xn") || mod.id.startsWith(VIRTUAL))) server!.moduleGraph.invalidateModule(mod);
      }
      server?.ws.send({ type: "full-reload" });
      return [];
    },
  };
}
