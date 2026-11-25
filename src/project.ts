/**
 * Project dependencies (`"dependencies"` in xenon.json): other Xenon projects, usually libraries,
 * whose sources are compiled with the program. A dependency is a project folder (`"../ui-lib"`) or
 * an npm package (`"@me/ui"`, looked up in `node_modules` folders from the project upwards) with a
 * `xenon.json`. Its own dependencies come along; each project is compiled once.
 *
 * Synchronous: the language server locates projects synchronously.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** A dependency found on disk. */
export interface Dependency {
  /** As written in xenon.json. */
  name: string;
  /** The project folder (with its `xenon.json`). */
  dir: string;
  /** Its source folder. */
  src: string;
  /** Its `"globals"`: packages it expects a page to load. */
  globals: Record<string, string>;
  /** Whether it is marked `"library": true`. */
  library: boolean;
}

export class DependencyError extends Error {}

interface ProjectJson {
  src?: unknown;
  dependencies?: unknown;
  globals?: unknown;
  library?: unknown;
  nullSafety?: unknown;
}

function readJson(file: string): ProjectJson {
  try {
    const json: unknown = JSON.parse(readFileSync(file, "utf8"));
    return json && typeof json === "object" ? (json as ProjectJson) : {};
  } catch (e) {
    throw new DependencyError(`invalid ${file}: ${(e as Error).message}`);
  }
}

/** `"dependencies"` as written: a list of non-empty strings, or an error. */
export function dependencyList(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((d) => typeof d !== "string" || d === "")) {
    throw new DependencyError(`"dependencies" in ${where} lists project folders or npm packages, e.g. ["../ui-lib", "@me/ui"]`);
  }
  return value as string[];
}

/** A path-like entry (`./x`, `../x`, `/x`) is a folder; anything else names an npm package. */
const isPath = (name: string) => name.startsWith(".") || isAbsolute(name);

/** The folder of a dependency named in the project at `from`. */
function locate(name: string, from: string): string | undefined {
  if (isPath(name)) {
    const dir = resolve(from, name);
    return existsSync(join(dir, "xenon.json")) ? dir : undefined;
  }
  for (let dir = from; ; ) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "xenon.json"))) return candidate;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * The dependencies of the project in `projectDir` and theirs, each once, in the order found
 * (depth first). Throws a `DependencyError` for a missing one, a cycle, a dependency whose null
 * safety differs from the project's, or two that map one package to different globals.
 */
export function resolveDependencies(projectDir: string, names: string[], options: { nullSafety: boolean; globals?: Record<string, string> }): Dependency[] {
  const found: Dependency[] = [];
  const seen = new Map<string, Dependency>(); // real path → dependency
  const globals: Record<string, string> = { ...options.globals };
  const owner: Record<string, string> = {};
  const visit = (from: string, list: string[], chain: string[]) => {
    for (const name of list) {
      const dir = locate(name, from);
      const where = relative(process.cwd(), join(from, "xenon.json")) || "xenon.json";
      if (!dir) {
        throw new DependencyError(isPath(name)
          ? `dependency not found: ${name} (in ${where}): no xenon.json in ${relative(process.cwd(), resolve(from, name)) || "."}`
          : `dependency not found: ${name} (in ${where}): no node_modules/${name}/xenon.json (install it, or name its folder: "./path/to/${name}")`);
      }
      const real = realpathSync(dir);
      if (chain.includes(real)) throw new DependencyError(`dependency cycle: ${[...chain, real].map((d) => relative(process.cwd(), d) || ".").join(" → ")}`);
      if (seen.has(real)) continue;
      const json = readJson(join(dir, "xenon.json"));
      const src = resolve(dir, typeof json.src === "string" ? json.src : "src");
      if ((json.nullSafety !== false) !== options.nullSafety) {
        throw new DependencyError(`dependency ${name} is compiled ${json.nullSafety === false ? "without" : "with"} null safety, this project ${options.nullSafety ? "with" : "without"} it: set "nullSafety" the same in both`);
      }
      const own = json.globals && typeof json.globals === "object" ? (json.globals as Record<string, unknown>) : {};
      for (const [pkg, global] of Object.entries(own)) {
        if (typeof global !== "string" || global === "") continue;
        if (globals[pkg] !== undefined && globals[pkg] !== global) {
          throw new DependencyError(`"globals": ${pkg} is \`${globals[pkg]}\` in ${owner[pkg] ?? "this project"} but \`${global}\` in ${name}`);
        }
        globals[pkg] = global;
        owner[pkg] ??= name;
      }
      const dep: Dependency = { name, dir, src, globals: Object.fromEntries(Object.entries(own).filter(([, g]) => typeof g === "string")) as Record<string, string>, library: json.library === true };
      seen.set(real, dep);
      found.push(dep);
      visit(dir, dependencyList(json.dependencies, join(relative(process.cwd(), dir) || ".", "xenon.json")), [...chain, real]);
    }
  };
  visit(projectDir, names, [realpathSync(projectDir)]);
  return found;
}

/** The project's `globals` with its dependencies' added (`resolveDependencies` reported clashes). */
export function mergedGlobals(own: Record<string, string>, deps: Dependency[]): Record<string, string> {
  const all = { ...own };
  for (const d of deps) for (const [pkg, global] of Object.entries(d.globals)) all[pkg] ??= global;
  return all;
}
