/** Typed, unbound property references (`Type::member`). */
import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENTRY_FILE } from "../src/codegen.ts";
import { compileProject } from "../src/compiler.ts";

const out = join(import.meta.dir, ".property-reference-out");
afterAll(() => rm(out, { recursive: true, force: true }));

test("property references read fields/getters and dispatch methods with the supplied receiver", async () => {
  const result = compileProject([
    { path: "User.xn", text: `public class User {
  public final name:String
  public function User(name:String) { this.name = name }
  public function get upper():String => name.toUpperCase()
  public function label(prefix:String):String => prefix + name
  public function shout():String => name.toUpperCase()
}` },
    { path: "Box.xn", text: `public class Box<T> {
  public final value:T
  public function Box(value:T) { this.value = value }
  public function get():T => value
}` },
    { path: "Main.xn", text: `public class Main {
  public function Main() {
    var user:User = new User('Ann')
    var readName:PropertyReference<User, String> = User::name
    var readUpper:(User) -> String = User::upper
    var label:(User, String) -> String = User::label
    var box:Box<String> = new Box('boxed')
    var readBox:(Box<String>) -> String = Box::value
    var getBox:(Box<String>) -> String = Box::get
    trace(readName(user), readUpper(user), label(user, 'Hi '), User::label(user, 'Yo '), readBox(box), getBox(box), nameof(User::name), nameof(User::label))
  }
}` },
  ], { main: "Main" });
  const errors = result.diagnostics.items.filter((d) => d.severity === "error");
  expect(errors.map((d) => d.message)).toEqual([]);
  for (const file of result.outputs) {
    await mkdir(dirname(join(out, file.path)), { recursive: true });
    await Bun.write(join(out, file.path), file.text);
  }
  const main = result.outputs.find((file) => file.path === "Main.js")!.text;
  expect(main).toContain("($receiver) => $receiver.name");
  expect(main).toContain("($receiver, ...$args) => $receiver.label(...$args)");
  expect(main).toContain("'name', 'label'");
  expect(main).not.toContain("::");
  const child = Bun.spawn(["bun", join(out, ENTRY_FILE)], { stdout: "pipe", stderr: "pipe" });
  const printed = await new Response(child.stdout).text();
  expect((await new Response(child.stderr).text())).toBe("");
  expect(await child.exited).toBe(0);
  expect(printed.trim()).toBe("Ann ANN Hi Ann Yo Ann boxed boxed name label");
});

test("property references reject static members and incompatible function types", () => {
  const result = compileProject([
    { path: "User.xn", text: `public class User {
  public static function create(name:String):User => new User()
  public function label(prefix:String):String => prefix
  public function User() {}
}` },
    { path: "Main.xn", text: `public class Main {
  public function Main() {
    var create:(User, String) -> User = User::create
    var wrong:(User) -> String = User::label
    var missing:(User) -> String = User::unknown
  }
}` },
  ], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.code)).toEqual(["X0608", "X0308", "X0426"]);
});

test("PropertyReference emits a real TypeScript function type", () => {
  const result = compileProject([
    { path: "Main.xn", text: `public class Main {
  public final name:String = ''
  public function Main() {}
  public function read():PropertyReference<Main, String> => Main::name
}` },
  ], { main: "Main", target: "ts" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const ts = result.outputs.find((file) => file.path === "Main.ts")!.text;
  expect(ts).toContain("read(): (owner: Main) => string");
  expect(ts).not.toContain("PropertyReference<");
});
