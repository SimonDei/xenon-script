/** Scoped classes (src/scoped.ts): values destroyed when the scope owning them ends, as the program runs. */
import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENTRY_FILE } from "../src/codegen.ts";
import { compileProject } from "../src/compiler.ts";
import { renderAll } from "../src/diagnostics.ts";

const outRoot = join(import.meta.dir, ".scoped-out");
afterAll(() => rm(outRoot, { recursive: true, force: true }));

/** A resource logging its destruction, shared by the programs below. */
const RES = `
class Res {
  public final name:String
  public function Res(name:String) { this.name = name }
  public function ~Res() { Main.log.push('~' + name) }
  public function read():String { return name }
}
`;

let runs = 0;

/** Compiles `main` (a `Main` class body using `log`) with `extra` classes, runs it and returns what it printed. */
async function run(main: string, extra = RES): Promise<string> {
  const text = `public class Main {
  public static var log:Array<String> = []
${main}
}
${extra}`;
  const result = compileProject([{ path: "Main.xn", text }], { main: "Main" });
  const errors = result.diagnostics.items.filter((d) => d.severity === "error");
  expect(renderAll(errors, { color: false })).toBe("");
  const out = join(outRoot, String(++runs));
  for (const o of result.outputs) {
    await mkdir(dirname(join(out, o.path)), { recursive: true });
    await Bun.write(join(out, o.path), o.text);
  }
  const proc = Bun.spawn(["bun", join(out, ENTRY_FILE)], { stdout: "pipe", stderr: "pipe" });
  const printed = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  await proc.exited;
  return printed.trim();
}

test("locals are destroyed at the end of their block, last declared first, on every exit", async () => {
  expect(await run(`
  public function Main() {
    var a:Res = new Res('a')
    var b:Res = new Res('b')
    if (true) {
      var inner:Res = new Res('inner')
      log.push('in')
    }
    log.push('out')
    early(true)
    for (var i:int of 0..3) {
      var c:Res = new Res('c' + i)
      if (i == 0) continue
      if (i == 2) break
      log.push('body' + i)
    }
    trace(log.join(' '))
  }

  private function early(stop:Boolean):void {
    var e:Res = new Res('e')
    if (stop) return
    log.push('not reached')
  }`)).toBe("in ~inner out ~e ~c0 body1 ~c1 ~c2");
});

test("`return` hands a value on through several functions; the last owner destroys it", async () => {
  expect(await run(`
  public function Main() {
    var r:Res = outer()
    log.push('got ' + r.read())
    done()
  }

  private function done():void {
    trace(log.join(' '))
  }

  private function outer():Res {
    var kept:Res = inner()
    var other:Res = new Res('other')
    log.push('outer')
    return kept
  }

  private function inner():Res {
    var made:Res = new Res('made')
    return made
  }`)).toBe("outer ~other got made");
});

test("temporaries are destroyed when their statement ends, the last created first", async () => {
  expect(await run(`
  public function Main() {
    new Res('discarded')
    log.push('len ' + new Res('four').read().length)
    var both:String = join(new Res('x'), new Res('y'))
    log.push(both)
    log.push(name())
    trace(log.join(' '))
  }

  private function join(a:Res, b:Res):String {
    return a.read() + b.read()
  }

  private function name():String {
    return new Res('ret').read()
  }`)).toBe("~discarded len 4 ~four ~y ~x xy ~ret ret");
});

test("errors: the scope's error is kept; a destructor's error alone is thrown; both make a SuppressedError", async () => {
  expect(await run(`
  public function Main() {
    try {
      var r:Res = new Res('r')
      throw new StateException('body')
    } catch (e:StateException) {
      log.push('caught ' + e.message)
    }
    try {
      var f:Failing = new Failing('alone')
      log.push('fine')
    } catch (e:Exception) {
      log.push('caught ' + e.message)
    }
    try {
      var f2:Failing = new Failing('dtor')
      throw new StateException('body')
    } catch (e:Exception) {
      var s:* = e.cause
      log.push(s.name + ': ' + s.error.message + ' / ' + s.suppressed.message)
    }
    trace(log.join(' | '))
  }`, RES + `
class Failing {
  private final what:String
  public function Failing(what:String) { this.what = what }
  public function ~Failing() { throw new StateException(what) }
}
`)).toBe("~r | caught body | fine | caught alone | SuppressedError: dtor / body");
});

test("subclass destructors run before their parent's; async destructors are awaited in order", async () => {
  expect(await run(`
  public function Main() {
    var c:Child = new Child('c')
    go()
  }

  private async function go():Promise<void> {
    var a:Conn = new Conn('a')
    var b:Conn = new Conn('b')
    await Promise.resolve()
    log.push('work')
    await finish()
  }

  private async function finish():Promise<void> {
    var t:Conn = new Conn('t')
  }`, RES + `
class Child extends Res {
  public function Child(name:String) { super(name) }
  public function ~Child() { Main.log.push('~child') }
}

class Conn {
  private final name:String
  public function Conn(name:String) { this.name = name }
  public async function ~Conn() {
    await Promise.resolve()
    Main.log.push('closed ' + name)
    if (name == 'a') trace(Main.log.join(' '))
  }
}
`)).toBe("~child ~c work closed t closed b closed a");
});

test("a scoped class's destructor is a prelude symbol, not Symbol.dispose, and has no dispose()", () => {
  const text = `public class Main {
  public function Main() {
    var r:Res = new Res()
  }
}
class Res {
  public function ~Res() {}
}
`;
  const js = compileProject([{ path: "Main.xn", text }], { main: "Main" }).outputs.find((o) => o.path === "Main.js")!.text;
  expect(js).toContain("[$Destroy]() {");
  expect(js).not.toContain("Symbol.dispose");
  expect(js).not.toContain("dispose()");
  expect(js).not.toContain("#disposed");
  expect(js).toContain("import { $Destroy, $destroy, $noError } from './xenon/Prelude.js';");
});

test("deferred statements run in reverse order on normal and early exits", async () => {
  expect(await run(`
  public function Main() {
    normal()
    stop()
    try {
      fail()
    } catch (e:Exception) {
      log.push(e.message)
    }
    trace(log.join(' '))
  }

  private function normal():void {
    defer log.push('normal-1')
    defer {
      log.push('normal-2')
    }
    log.push('normal-body')
  }

  private function stop():void {
    defer log.push('return-defer')
    log.push('return-body')
    return
  }

  private function fail():void {
    defer log.push('throw-defer')
    throw new Exception('throw-body')
  }`)).toBe("normal-body normal-2 normal-1 return-body return-defer throw-defer throw-body");
});

test("deferred statements and scoped locals unwind in registration order", async () => {
  expect(await run(`
  public function Main() {
    work()
    trace(log.join(' '))
  }

  private function work():void {
    var before:Res = new Res('before')
    defer log.push('defer-before')
    var after:Res = new Res('after')
    defer log.push('defer-after')
    log.push('body')
  }`)).toBe("body defer-after ~after defer-before ~before");
});
