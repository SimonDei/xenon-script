/** `klass watch --run` end to end: edits, errors, fixes, added and deleted files. */
import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const dir = join(import.meta.dir, ".watch-project");
const cli = join(import.meta.dir, "..", "src", "cli.ts");
afterAll(() => rm(dir, { recursive: true, force: true }));

const main = (body: string) => `package {\n  public class Main {\n    public function Main() {\n      ${body}\n    }\n  }\n}\n`;

/** Collects a stream's text and lets the test wait for a pattern to appear after a given offset. */
function collector(stream: ReadableStream<Uint8Array>) {
  let text = "";
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) text += decoder.decode(chunk);
  })();
  return {
    get text() {
      return text;
    },
    async waitFor(pattern: RegExp, from = 0, ms = 5000): Promise<number> {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = pattern.exec(text.slice(from));
        if (m) return from + m.index + m[0].length;
        await Bun.sleep(20);
      }
      throw new Error(`timed out waiting for ${pattern}; got:\n${text.slice(from)}`);
    },
  };
}

test("watch rebuilds, restarts, stops on errors and removes stale outputs", async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "src"), { recursive: true });
  await Bun.write(join(dir, "src", "Main.kl"), main("trace('v1')"));

  const proc = Bun.spawn(["bun", cli, "watch", "--run", "--no-clear", "--color", "never", "--src", "src", "--out", "out"], {
    cwd: dir, stdout: "pipe", stderr: "pipe",
  });
  const out = collector(proc.stdout);
  const err = collector(proc.stderr);
  try {
    let e = await err.waitFor(/built 3 of 3 outputs from 1 file .*watching for changes/);
    let o = await out.waitFor(/v1\n/);

    await Bun.write(join(dir, "src", "Main.kl"), main("trace('v2')"));
    e = await err.waitFor(/built 1 of 3 outputs/, e);
    o = await out.waitFor(/v2\n/, o);

    await Bun.write(join(dir, "src", "Main.kl"), main("trace(missing)"));
    e = await err.waitFor(/cannot find `missing`[\s\S]*✗ 1 error — watching for changes/, e);

    await Bun.write(join(dir, "src", "Helper.kl"), "package {\n  public class Helper {\n    public static function hi():String { return 'hi' }\n  }\n}\n");
    await Bun.write(join(dir, "src", "Main.kl"), main("trace(Helper.hi())"));
    e = await err.waitFor(/✓ built .* from 2 files/, e);
    o = await out.waitFor(/hi\n/, o);
    expect(await Bun.file(join(dir, "out", "Helper.js")).exists()).toBe(true);

    await Bun.write(join(dir, "src", "Main.kl"), main("trace('v3')"));
    await rm(join(dir, "src", "Helper.kl"));
    e = await err.waitFor(/removed 1 stale/, e);
    o = await out.waitFor(/v3\n/, o);
    expect(await Bun.file(join(dir, "out", "Helper.js")).exists()).toBe(false);
  } finally {
    proc.kill("SIGINT");
    await proc.exited;
  }
}, 30000);
