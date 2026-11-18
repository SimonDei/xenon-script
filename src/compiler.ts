import { posix } from "node:path";
import type * as A from "./ast.ts";
import { check, type ClassInfo, type TypedefInfo } from "./checker.ts";
import { generate, type OutputFile } from "./codegen.ts";
import { DiagnosticBag } from "./diagnostics.ts";
import { parseFile } from "./parser.ts";
import preludeSource from "./prelude/Prelude.kl" with { type: "text" };
import stdArray from "./prelude/std/Array.kl" with { type: "text" };
import stdBoolean from "./prelude/std/Boolean.kl" with { type: "text" };
import stdConsole from "./prelude/std/console.kl" with { type: "text" };
import stdDate from "./prelude/std/Date.kl" with { type: "text" };
import stdFloat from "./prelude/std/Float.kl" with { type: "text" };
import stdInt from "./prelude/std/int.kl" with { type: "text" };
import stdString from "./prelude/std/String.kl" with { type: "text" };
import stdUint from "./prelude/std/uint.kl" with { type: "text" };
import stdIterator from "./prelude/std/Iterator.kl" with { type: "text" };
import stdJSON from "./prelude/std/JSON.kl" with { type: "text" };
import stdMap from "./prelude/std/Map.kl" with { type: "text" };
import stdMath from "./prelude/std/Math.kl" with { type: "text" };
import stdRegExp from "./prelude/std/RegExp.kl" with { type: "text" };
import stdSet from "./prelude/std/Set.kl" with { type: "text" };
import stdPromise from "./prelude/std/Promise.kl" with { type: "text" };
import { SourceFile } from "./source.ts";

/** Package of the built-in prelude; reserved for the compiler. */
export const PRELUDE_PACKAGE = "klass";
/** The prelude: runtime classes (`Prelude.kl`) and the standard library's native declarations (`std/`). */
export const PRELUDE: SourceInput[] = [
  { path: "klass/Prelude.kl", text: preludeSource },
  { path: "klass/Array.kl", text: stdArray },
  { path: "klass/Boolean.kl", text: stdBoolean },
  { path: "klass/console.kl", text: stdConsole },
  { path: "klass/Date.kl", text: stdDate },
  { path: "klass/Float.kl", text: stdFloat },
  { path: "klass/int.kl", text: stdInt },
  { path: "klass/String.kl", text: stdString },
  { path: "klass/uint.kl", text: stdUint },
  { path: "klass/Iterator.kl", text: stdIterator },
  { path: "klass/JSON.kl", text: stdJSON },
  { path: "klass/Map.kl", text: stdMap },
  { path: "klass/Math.kl", text: stdMath },
  { path: "klass/Promise.kl", text: stdPromise },
  { path: "klass/RegExp.kl", text: stdRegExp },
  { path: "klass/Set.kl", text: stdSet },
];

export interface SourceInput {
  /** Path relative to the source root, using `/` (determines the expected package). */
  path: string;
  text: string;
}

export interface CompileOptions {
  /** Qualified name of the main (document) class, e.g. `Main` or `com.app.Main`. */
  main: string;
  maxErrors?: number;
}

export interface CompileResult {
  outputs: OutputFile[];
  diagnostics: DiagnosticBag;
  files: SourceFile[];
}

/** Compiles a whole project held in memory. Never throws for user errors; check `diagnostics`. */
export function compileProject(sources: SourceInput[], options: CompileOptions): CompileResult {
  const diags = new DiagnosticBag(options.maxErrors);
  const files = [
    ...PRELUDE.map((s) => new SourceFile(s.path, s.text, true)),
    ...sources.map((s) => new SourceFile(s.path, s.text)),
  ];
  const asts = files.map((f) => parseFile(f, diags));

  const typedefs = new Map<string, TypedefInfo>();
  const classes = collectClasses(asts, diags, typedefs);
  const mainInfo = checkMain(classes, options.main, files.filter((f) => !f.prelude), diags);
  const result = check(asts, classes, typedefs, diags);

  diags.applySuppressions();
  const userFiles = files.filter((f) => !f.prelude);
  if (diags.hasErrors || !mainInfo) return { outputs: [], diagnostics: diags, files: userFiles };
  return { outputs: generate(asts, result, mainInfo), diagnostics: diags, files: userFiles };
}

function collectClasses(asts: A.KlassFile[], diags: DiagnosticBag, typedefs: Map<string, TypedefInfo>): Map<string, ClassInfo> {
  const classes = new Map<string, ClassInfo>();
  const preludeNames = new Map<string, A.TypeDecl>();
  for (const ast of asts) {
    const pkg = ast.packageName.map((n) => n.name).join(".");
    const pathParts = ast.file.path.replace(/\.kl$/, "").split("/");
    const fileName = pathParts.pop()!;
    const expectedPkg = pathParts.join(".");

    if (ast.packageSpan && pkg !== expectedPkg) {
      const expected = expectedPkg === "" ? "the top-level package (`package { … }`)" : `\`package ${expectedPkg}\``;
      diags.error("K0020", `package \`${pkg || "(top level)"}\` doesn't match the file's directory`, ast.packageSpan, `expected ${expected}`)
        .note("a file's package must match its directory below the source root");
    }

    const prelude = ast.file.prelude;
    if (!prelude && pkg.split(".")[0] === PRELUDE_PACKAGE && ast.packageSpan) {
      diags.error("K0027", `the package name \`${PRELUDE_PACKAGE}\` is reserved for the built-in prelude`, ast.packageSpan);
    }
    if (ast.decls.length > 1 && !prelude) {
      for (const extra of ast.decls.slice(1)) {
        diags.error("K0021", "only one definition is allowed inside a package block", extra.name.span)
          .help("move helper classes after the package block, where they are file-private");
      }
    }
    for (const decl of ast.decls) {
      if (decl.name.name !== fileName && !prelude) {
        diags.error("K0022", `${decl.kind === "Typedef" ? "typedef" : decl.isInterface ? "interface" : decl.isEnum ? "enum" : "class"} \`${decl.name.name}\` must be declared in a file named \`${decl.name.name}.kl\``, decl.name.span, `this file is \`${fileName}.kl\``);
      }
      const vis = decl.modifiers.visibility;
      if (vis && vis.value !== "public" && vis.value !== "internal") {
        diags.error("K0023", "classes can only be `public` or `internal`", vis.span);
      }
    }

    const module = posix.join(...(pkg === "" ? [] : pkg.split(".")), `${fileName}.js`);
    const add = (decl: A.TypeDecl, filePrivate: boolean) => {
      if (decl.kind === "Typedef") {
        if (prelude) preludeNames.set(decl.name.name, decl);
        else if (preludeNames.has(decl.name.name)) {
          diags.error("K0028", `\`${decl.name.name}\` is the name of a built-in type`, decl.name.span)
            .note(`the prelude declares \`${decl.name.name}\` for every file; pick another name`);
          return;
        }
        const qname = filePrivate ? `${ast.file.path}#${decl.name.name}` : pkg ? `${pkg}.${decl.name.name}` : decl.name.name;
        const prev = typedefs.get(qname) ?? classes.get(qname);
        if (prev) {
          diags.error("K0024", `\`${qname}\` is defined more than once`, decl.name.span).secondary(prev.decl.name.span, "first defined here");
          return;
        }
        typedefs.set(qname, { decl, file: ast, pkg, qname, filePrivate, params: uniqueParams(decl.typeParams, diags) });
        return;
      }
      if (prelude) preludeNames.set(decl.name.name, decl);
      else if (preludeNames.has(decl.name.name)) {
        const builtin = preludeNames.get(decl.name.name)!;
        diags.error("K0028", `\`${decl.name.name}\` is the name of a built-in ${builtin.kind === "Typedef" ? "type" : "class"}`, decl.name.span)
          .note(builtin.kind === "Typedef"
            ? `the prelude declares \`${decl.name.name}\` for every file; pick another name`
            : builtin.modifiers.native
            ? `the standard library declares \`${decl.name.name}\` for every file; pick another name`
            : `built-in classes like \`Exception\` are available in every file; pick another name`);
        return;
      }
      const qname = filePrivate ? `${ast.file.path}#${decl.name.name}` : pkg ? `${pkg}.${decl.name.name}` : decl.name.name;
      const prev = classes.get(qname) ?? typedefs.get(qname);
      if (prev) {
        diags.error("K0024", `class \`${qname}\` is defined more than once`, decl.name.span).secondary(prev.decl.name.span, "first defined here");
        return;
      }
      classes.set(qname, { decl, file: ast, pkg, qname, filePrivate, module, members: new Map(), interfaces: [], typeParams: uniqueParams(decl.typeParams, diags), parentArgs: [], interfaceArgs: [] });
    };
    for (const decl of ast.decls) add(decl, false);
    const clash = [...classes.values()].find((c) => !c.filePrivate && c.file !== ast && c.module.toLowerCase() === module.toLowerCase());
    if (clash && ast.decls[0]) {
      diags.error("K0026", `\`${ast.decls[0].name.name}\` and \`${clash.qname}\` differ only in letter case`, ast.decls[0].name.span)
        .secondary(clash.decl.name.span, "other class here")
        .note("their output modules would collide on case-insensitive file systems and in Bun's module cache");
    }
    for (const decl of ast.privateDecls) {
      if (decl.modifiers.visibility) {
        const d = diags.error("K0025", "file-private classes can't have a visibility modifier", decl.modifiers.visibility.span);
        if (!ast.packageSpan && ast.decls[0]) {
          // A root file without a package block: only the declaration named after the file is shared.
          d.note(`in \`${fileName}.kl\`, only \`${ast.decls[0].name.name}\` is visible to other files; the others are file-private`)
            .help(`to share \`${decl.name.name}\`, move it to its own file \`${decl.name.name}.kl\``);
        }
      }
      add(decl, true);
    }
  }
  return classes;
}

function checkMain(classes: Map<string, ClassInfo>, main: string, files: SourceFile[], diags: DiagnosticBag): ClassInfo | undefined {
  const info = classes.get(main);
  if (!info || info.filePrivate) {
    // The main class's file exists but is broken: that error already explains the missing class.
    const mainPath = `${main.split(".").join("/")}.kl`;
    const brokenMain = files.some((f) => f.path === mainPath) && diags.items.some((d) => d.severity === "error" && d.labels.some((l) => l.span.file.path === mainPath));
    if (brokenMain) {
      // reported already
    } else if (files.length > 0) {
      const d = diags.error("K0001", `main class \`${main}\` not found`);
      const candidates = [...classes.values()].filter((c) => !c.filePrivate && !c.file.file.prelude).map((c) => c.qname);
      if (candidates.length > 0) d.note(`classes in this project: ${candidates.map((c) => `\`${c}\``).join(", ")}`);
      d.help("set the main class with `--main <qualified.Name>` or `\"main\"` in klass.json");
    } else {
      diags.error("K0003", "no `.kl` source files found");
    }
    return undefined;
  }
  if (info.decl.modifiers.visibility?.value !== "public") {
    diags.error("K0004", `main class \`${main}\` must be \`public\``, info.decl.name.span);
  }
  const ctor = info.decl.members.find((m): m is A.Method => m.kind === "Method" && m.isConstructor);
  const required = ctor?.params.filter((p) => !p.init && !p.rest) ?? [];
  if (ctor && required.length > 0) {
    diags.error("K0005", `the main class constructor can't have required parameters`, required[0]!.span)
      .note("the program starts with `new Main()`, so there is nothing to pass");
  }
  return info;
}

/** Type parameters of a class/typedef; a repeated name is reported and dropped. */
function uniqueParams(params: A.Ident[] | undefined, diags: DiagnosticBag): { name: string }[] {
  const seen = new Set<string>();
  return (params ?? []).flatMap((p) => {
    if (seen.has(p.name)) {
      diags.error("K0796", `type parameter \`${p.name}\` is declared twice`, p.span);
      return [];
    }
    seen.add(p.name);
    return [{ name: p.name }];
  });
}
