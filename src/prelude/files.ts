/**
 * The prelude's sources, read at build time: `compiler.ts` imports `preludeFiles` as a Bun macro
 * (`with { type: "macro" }`), so the call is replaced by its result, an array literal with every
 * file's text, when Bun transpiles or bundles the compiler. A new file in `std/` is picked up
 * without being listed anywhere.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PreludeFile {
  /** Path as the compiler sees it: every prelude file belongs to the `xenon` package. */
  path: string;
  text: string;
}

/** `Prelude.xn` (the runtime classes) first, then the standard library's declarations (`std/*.xn`) by name. */
export function preludeFiles(): PreludeFile[] {
  const std = [...new Bun.Glob("*.xn").scanSync({ cwd: join(import.meta.dir, "std") })].sort();
  return [
    { path: "xenon/Prelude.xn", text: readFileSync(join(import.meta.dir, "Prelude.xn"), "utf8") },
    ...std.map((f) => ({ path: `xenon/${f}`, text: readFileSync(join(import.meta.dir, "std", f), "utf8") })),
  ];
}
