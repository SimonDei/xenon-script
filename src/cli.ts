#!/usr/bin/env bun
import { join, relative, resolve } from "node:path";
import { build, type Config, runCommand } from "./build.ts";
import { explain } from "./codes.ts";
import { watchProject } from "./watch.ts";

const USAGE = `xenon — compiler for the Xenon language

Usage:
  xenon build   [options]          compile the project
  xenon check   [options]          type-check only, no output
  xenon run     [options] [-- args] build, then run with Bun
  xenon watch   [options] [-- args] rebuild on every change (--run: restart the program)
  xenon explain <code>             explain an error code, e.g. xenon explain X0308
  xenon lsp     [--stdio]          language server for editors (LSP over stdio)

Options:
  --project <path>   project file, or a folder with a xenon.json (default: ./xenon.json if present)
  --src <dir>        source root (default: src)
  --out <dir>        output directory (default: out)
  --main <name>      main class, e.g. Main or com.app.Main (default: Main)
  --format pretty|json
  --color auto|always|never
  --max-errors <n>   (default: 50)
  --deny-warnings    treat warnings as errors
  --quiet            only print diagnostics
  --no-source-maps   don't write .js.map files (stack traces then show the JavaScript)
  --target js|ts     output JavaScript (default) or typed TypeScript (.ts, no source maps)
  --bundle           (build, run, watch) one xenon-main.js for all compiled .xn files;
                     npm packages, node:/bun: modules and src/ JavaScript files stay outside
  --run              (watch) run the program after each successful build
  --no-clear         (watch) don't clear the terminal between builds
`;

class UsageError extends Error {}

async function isDirectory(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  return stat(path).then((s) => s.isDirectory(), () => false);
}

async function loadConfig(args: string[]): Promise<{
  command: string;
  config: Config;
  rest: string[];
  root: string;
  projectPath: string;
  flags: Map<string, string | true>;
}> {
  const command = args[0] ?? "";
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument \`${a}\``);
    const name = a.slice(2);
    if (["deny-warnings", "quiet", "run", "no-clear", "no-source-maps", "bundle"].includes(name)) flags.set(name, true);
    else {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`missing value for \`${a}\``);
      flags.set(name, v);
    }
  }

  let projectPath = resolve((flags.get("project") as string | undefined) ?? "xenon.json");
  if (flags.has("project") && (await isDirectory(projectPath))) projectPath = join(projectPath, "xenon.json");
  const projectFile = Bun.file(projectPath);
  let project: Partial<Config> = {};
  if (await projectFile.exists()) {
    try {
      project = await projectFile.json();
    } catch (e) {
      throw new UsageError(`invalid ${relative(process.cwd(), projectPath)}: ${(e as Error).message}`);
    }
  } else if (flags.has("project")) {
    throw new UsageError(`project file not found: ${projectPath}`);
  }
  const root = resolve(projectPath, "..");

  const colorFlag = (flags.get("color") as string | undefined) ?? "auto";
  if (!["auto", "always", "never"].includes(colorFlag)) throw new UsageError("--color must be auto, always or never");
  const target = (flags.get("target") as string | undefined) ?? project.target ?? "js";
  if (target !== "js" && target !== "ts") throw new UsageError("--target must be js or ts");
  const bundle = flags.has("bundle") || !!project.bundle;
  if (bundle && target === "ts") throw new UsageError("--bundle writes JavaScript: it can't be combined with --target ts");
  const format = (flags.get("format") as string | undefined) ?? "pretty";
  if (format !== "pretty" && format !== "json") throw new UsageError("--format must be pretty or json");

  const config: Config = {
    src: (flags.get("src") as string) ?? project.src ?? "src",
    out: (flags.get("out") as string) ?? project.out ?? "out",
    main: (flags.get("main") as string) ?? project.main ?? "Main",
    color: colorFlag === "always" || (colorFlag === "auto" && !!process.stderr.isTTY && !process.env.NO_COLOR),
    format,
    maxErrors: Number(flags.get("max-errors") ?? project.maxErrors ?? 50),
    denyWarnings: flags.has("deny-warnings") || !!project.denyWarnings,
    quiet: flags.has("quiet"),
    sourceMaps: !flags.has("no-source-maps") && project.sourceMaps !== false,
    target,
    bundle,
  };
  // `--src` names the folder of the .xn files; a project folder there is a mix-up with `--project`.
  const srcDir = resolve(root, config.src);
  if (flags.has("src") && (await Bun.file(join(srcDir, "xenon.json")).exists())) {
    const dir = relative(process.cwd(), srcDir) || ".";
    throw new UsageError(`\`${dir}\` is a project folder (it has a xenon.json), not a source root: use \`--project ${dir}\``);
  }
  return { command, config, rest, root, projectPath, flags };
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  if (argv[0] === "lsp") {
    // The language server speaks LSP over stdio until the editor closes the connection.
    const { startServer } = await import("./lsp.ts");
    startServer();
    return await new Promise<number>(() => {});
  }
  if (argv[0] === "explain") {
    const code = argv[1];
    const text = code ? explain(code) : undefined;
    if (!text) {
      process.stderr.write(code ? `error: unknown error code \`${code}\`\n` : "error: `xenon explain` needs an error code, e.g. X0308\n");
      return 2;
    }
    process.stdout.write(text);
    return 0;
  }
  try {
    const { command, config, rest, root, projectPath, flags } = await loadConfig(argv);
    switch (command) {
      case "build":
        return (await build(config, root, true)) ? 0 : 1;
      case "check":
        return (await build(config, root, false)) ? 0 : 1;
      case "run": {
        if (!(await build(config, root, true))) return 1;
        const child = Bun.spawn(runCommand(config, resolve(root, config.out), rest), { stdio: ["inherit", "inherit", "inherit"] });
        return await child.exited;
      }
      case "watch":
        return await watchProject(config, root, {
          run: flags.has("run"),
          clear: !flags.has("no-clear"),
          args: rest,
          projectFile: projectPath,
          reloadConfig: async () => (await loadConfig(argv)).config,
        });
      default:
        throw new UsageError(`unknown command \`${command}\``);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
}

process.exit(await main(process.argv.slice(2)));
