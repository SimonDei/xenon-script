import { type FSWatcher, watch } from "node:fs";
import { join, resolve } from "node:path";
import { type Config, readSources, report, syncOutputs } from "./build.ts";
import { ENTRY_FILE } from "./codegen.ts";
import { compileProject, type SourceInput } from "./compiler.ts";

export interface WatchOptions {
  /** Restart the program after every successful build (`--run`). */
  run: boolean;
  /** Clear the terminal before each build's output (default; `--no-clear` turns it off). */
  clear: boolean;
  /** Arguments passed to the program with `--run`. */
  args: string[];
  /** Re-reads xenon.json/flags when the project file changes. */
  reloadConfig: () => Promise<Config>;
  projectFile?: string;
}

/**
 * `xenon watch`: rebuilds on every change. Files are read once and then only when they change;
 * the project is re-checked as a whole (fast), only changed outputs are written, and outputs of
 * deleted files are removed. Resolves with the exit code when interrupted (Ctrl+C).
 */
export async function watchProject(initial: Config, root: string, opts: WatchOptions): Promise<number> {
  let config = initial;
  let srcRoot = resolve(root, config.src);
  let outDir = resolve(root, config.out);
  const cache = new Map<string, string>(); // source path → text
  const changed = new Set<string>(); // paths to re-read
  let rescan = true; // list the source directory again (files added/removed)
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let building = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const paint = (code: string, text: string) => (config.color ? `\x1b[${code}m${text}\x1b[0m` : text);

  const stopChild = async () => {
    if (!child) return;
    const c = child;
    child = undefined;
    c.kill();
    await c.exited;
  };

  const startChild = () => {
    child = Bun.spawn(["bun", join(outDir, ENTRY_FILE), ...opts.args], { stdio: ["inherit", "inherit", "inherit"] });
  };

  const rebuild = async () => {
    if (building) {
      again = true;
      return;
    }
    building = true;
    try {
      const started = performance.now();
      if (rescan) {
        const now = await readSources(srcRoot);
        cache.clear();
        for (const s of now) cache.set(s.path, s.text);
        rescan = false;
      } else {
        for (const path of changed) {
          const file = Bun.file(join(srcRoot, path));
          if (await file.exists()) cache.set(path, await file.text());
          else cache.delete(path);
        }
      }
      changed.clear();
      const sources: SourceInput[] = [...cache].sort(([a], [b]) => a.localeCompare(b)).map(([path, text]) => ({ path, text }));
      const result = compileProject(sources, { main: config.main, maxErrors: config.maxErrors });

      if (opts.clear) process.stderr.write("\x1b[2J\x1b[3J\x1b[H");
      const ok = report(result, config, srcRoot);
      const ms = Math.round(performance.now() - started);
      if (!ok) {
        await stopChild(); // don't keep running a stale build
        const n = result.diagnostics.errorCount;
        process.stderr.write(`${paint("31", "✗")} ${n} error${n === 1 ? "" : "s"} — watching for changes\n`);
        return;
      }
      const { written, removed } = await syncOutputs(result, outDir);
      const outputs = new Set(result.outputs.map((o) => o.path));
      const removedNote = removed > 0 ? `, removed ${removed} stale` : "";
      process.stderr.write(`${paint("32", "✓")} built ${written} of ${outputs.size} output${outputs.size === 1 ? "" : "s"} from ${sources.length} file${sources.length === 1 ? "" : "s"}${removedNote} in ${ms} ms — watching for changes\n`);
      if (opts.run && (written > 0 || removed > 0 || !child)) {
        await stopChild();
        startChild();
      }
    } finally {
      building = false;
      if (again) {
        again = false;
        void rebuild();
      }
    }
  };

  /** Editors save in bursts (write, rename, chmod): wait a moment and build once. */
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 50);
  };

  const watchers: FSWatcher[] = [];
  const watchSources = () => {
    watchers.push(watch(srcRoot, { recursive: true }, (_event, file) => {
      const path = file ? String(file).split("\\").join("/") : "";
      if (path.endsWith(".xn")) changed.add(path);
      else rescan = true; // a directory was added/removed/renamed
      schedule();
    }));
  };
  watchSources();
  if (opts.projectFile && (await Bun.file(opts.projectFile).exists())) {
    watchers.push(watch(opts.projectFile, async () => {
      try {
        config = await opts.reloadConfig();
      } catch (e) {
        process.stderr.write(`${paint("31", "✗")} ${(e as Error).message}\n`);
        return;
      }
      const newSrc = resolve(root, config.src);
      outDir = resolve(root, config.out);
      if (newSrc !== srcRoot) {
        srcRoot = newSrc;
        watchers.shift()?.close();
        watchSources();
      }
      rescan = true;
      schedule();
    }));
  }

  await rebuild();

  return new Promise<number>((done) => {
    process.once("SIGINT", async () => {
      clearTimeout(timer);
      for (const w of watchers) w.close();
      await stopChild();
      process.stderr.write("\n");
      done(0);
    });
  });
}
