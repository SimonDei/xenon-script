/** The prelude's Exception classes, used directly from JavaScript. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compileProject } from "../src/compiler.ts";

const out = join(import.meta.dir, ".prelude-out");
// biome-ignore lint: dynamic module
let K: any;

beforeAll(async () => {
  const result = compileProject([{ path: "Main.xn", text: "package { public class Main {} }" }], { main: "Main" });
  expect(result.diagnostics.items).toEqual([]);
  for (const o of result.outputs) {
    await mkdir(dirname(join(out, o.path)), { recursive: true });
    await Bun.write(join(out, o.path), o.text);
  }
  K = await import(join(out, "xenon", "Prelude.js"));
});

afterAll(() => rm(out, { recursive: true, force: true }));

test("Exception extends Error and names itself", () => {
  const e = new K.StateException("busy");
  expect(e).toBeInstanceOf(Error);
  expect(e).toBeInstanceOf(K.Exception);
  expect(e.name).toBe("StateException");
  expect(String(e)).toBe("StateException: busy");
  expect(e.stack).toContain("busy");
});

test("Exception.from normalizes JS errors and plain values", () => {
  const existing = new K.ArgumentException("x");
  expect(K.Exception.from(existing)).toBe(existing);

  const type = new TypeError("bad type");
  const t = K.Exception.from(type);
  expect(t).toBeInstanceOf(K.TypeException);
  expect(t.message).toBe("bad type");
  expect(t.cause).toBe(type);
  expect(t.stack).toBe(type.stack);

  expect(K.Exception.from(new RangeError("r"))).toBeInstanceOf(K.RangeException);
  const generic = K.Exception.from(new SyntaxError("s"));
  expect(generic.constructor).toBe(K.Exception);

  const str = K.Exception.from("oops");
  expect(str.message).toBe("Non-error value thrown: oops");
  expect(str.cause).toBe("oops");
  expect(String(str)).toBe("Exception: Non-error value thrown: oops (caused by oops)");
});
