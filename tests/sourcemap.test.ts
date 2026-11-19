/** Source maps: every generated line maps back to its Xenon statement; `xenon run` remaps stack traces. */
import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { decodeMappings, type SourceMap } from "../src/sourcemap.ts";

// Each `'Ln'` string marks a statement; the generated line holding it must map to the line holding it here.
const KEEPER = `package zoo {
  public class Keeper {
    public static var count:int = 0
    public var name:String = 'L4'
    static {
      count = 'L6'.length
    }
    public function Keeper(name:String) {
      this.name = name + 'L9'
    }
    public function get label():String {
      return 'L12' + name
    }
    public function feed(items:Array<String>):void {
      for (var item:String of items) {
        if (item == 'L16') {
          trace('L17')
        } else {
          trace('L19', item)
        }
      }
      items.forEach((item:String, i:int):void => {
        trace('L23', item)
        var inner:() -> String = function():String {
          return 'L25'
        }
        trace(inner())
      })
      try {
        trace('L30')
      } catch (e:Exception) {
        trace('L32', e)
      }
    }
  }
}
`;

const MAIN = `import zoo.Keeper

public class Main {
  public function Main() {
    new Keeper('L5').feed(['L5'])
  }
}
`;

test("generated lines map to the statements they come from", () => {
  const sources = [{ path: "zoo/Keeper.xn", text: KEEPER }, { path: "Main.xn", text: MAIN }];
  const result = compileProject(sources, { main: "Main", sourceMaps: { sourceRoot: "../src" } });
  expect(result.diagnostics.items.filter((d) => d.severity === "error")).toEqual([]);
  const files = new Map(result.outputs.map((o) => [o.path, o.text]));

  for (const [module, source] of [["zoo/Keeper.js", KEEPER], ["Main.js", MAIN]] as const) {
    const js = files.get(module)!;
    expect(js.trimEnd().endsWith(`//# sourceMappingURL=${module.split("/").pop()}.map`)).toBe(true);
    const map = JSON.parse(files.get(module + ".map")!) as SourceMap;
    expect(map.sources).toEqual([module === "Main.js" ? "../src/Main.xn" : "../../src/zoo/Keeper.xn"]);
    expect(map.sourcesContent).toEqual([source]);

    const lines = decodeMappings(map.mappings);
    const sourceLines = source.split("\n");
    let checked = 0;
    js.split("\n").forEach((line, i) => {
      const marker = /'(L\d+)'/.exec(line)?.[1];
      if (!marker) return;
      const seg = lines[i]?.[0];
      expect(seg, `generated line ${i + 1} (${line.trim()}) has no mapping`).toBeDefined();
      expect(sourceLines[seg![2]], `generated line ${i + 1}: ${line.trim()}`).toContain(`'${marker}'`);
      checked++;
    });
    expect(checked).toBe(module === "Main.js" ? 1 : 11); // every marker was checked
  }
  // The prelude's module has a map too, carrying its text.
  const prelude = JSON.parse(files.get("xenon/Prelude.js.map")!) as SourceMap;
  expect(prelude.sources).toEqual(["Prelude.xn"]);
  expect(prelude.sourcesContent[0]).toContain("class Exception");
});

test("without the option there are no maps", () => {
  const result = compileProject([{ path: "Main.xn", text: MAIN.replace("import zoo.Keeper\n", "").replace("new Keeper('L5').feed(['L5'])", "trace(1)") }], { main: "Main" });
  expect(result.outputs.some((o) => o.path.endsWith(".map"))).toBe(false);
  expect(result.outputs.some((o) => o.text.includes("sourceMappingURL"))).toBe(false);
});

const dir = join(import.meta.dir, ".sourcemap-project");
const cli = join(import.meta.dir, "..", "src", "cli.ts");
afterAll(() => rm(dir, { recursive: true, force: true }));

test("`xenon run` reports uncaught errors at their Xenon position", async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "src", "zoo"), { recursive: true });
  await Bun.write(join(dir, "src", "zoo", "Keeper.xn"), `package zoo {
  public class Keeper {
    public function feed(names:Array<String>):void {
      names.forEach((name:String, i:int):void => {
        if (i == 1) {
          throw new StateException('out of food for ' + name)
        }
      })
    }
  }
}
`);
  await Bun.write(join(dir, "src", "Main.xn"), MAIN.replace("new Keeper('L5').feed(['L5'])", "new Keeper().feed(['ann', 'bob'])"));

  const run = async (...flags: string[]) => {
    const proc = Bun.spawn(["bun", cli, "run", "--color", "never", "--src", "src", "--out", "out", ...flags], { cwd: dir, stderr: "pipe", stdout: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    return { code: await proc.exited, stderr };
  };

  const mapped = await run();
  expect(mapped.code).toBe(1);
  expect(mapped.stderr).toContain("6 |           throw new StateException('out of food for ' + name)");
  expect(mapped.stderr).toContain("StateException: out of food for bob");
  expect(mapped.stderr).toContain("at <anonymous> (src/zoo/Keeper.xn:6:11)");
  expect(mapped.stderr).toContain("at feed (src/zoo/Keeper.xn:4:7)");
  expect(mapped.stderr).toContain("at new Main (src/Main.xn:5:5)");
  expect(await Bun.file(join(dir, "out", "zoo", "Keeper.js.map")).exists()).toBe(true);

  const plain = await run("--no-source-maps");
  expect(plain.code).toBe(1);
  expect(plain.stderr).not.toContain("Keeper.xn");
  expect(plain.stderr).toContain("Keeper.js");
  expect(await Bun.file(join(dir, "out", "zoo", "Keeper.js.map")).exists()).toBe(false);
});
