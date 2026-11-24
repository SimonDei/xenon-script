import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const constraintErrors = (result: ReturnType<typeof compileProject>) =>
  result.diagnostics.items.filter((d) => d.code === "X0880").map((d) => d.message);

test("constraints expose bound members and support inference and F-bounds", () => {
  const result = compileProject([
    { path: "Animal.xn", text: `public class Animal {
  public function Animal() {}
  public function label():String => 'animal'
}` },
    { path: "Dog.xn", text: `public class Dog extends Animal {
  public function Dog() {}
  public override function label():String => 'dog'
}` },
    { path: "Comparable.xn", text: "public interface Comparable<T> { function compare(other:T):Int }" },
    { path: "DogComparable.xn", text: "public class DogComparable implements Comparable<DogComparable> { public function DogComparable() {} public function compare(other:DogComparable):Int => 0 }" },
    { path: "Tools.xn", text: `public static class Tools {
  public static function name<T extends Animal>(value:T):String => value.label()
  public static function ordered<T extends Comparable<T>>(value:T):Int => value.compare(value)
}` },
    { path: "Main.xn", text: `public class Main {
  public function Main() {}
  public static function run():String => Tools.name(new Dog()) + Tools.ordered(new DogComparable())
}` },
  ], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error")).toEqual([]);
});

test("explicit, inherited, inferred, and typedef arguments must satisfy constraints", () => {
  const result = compileProject([
    { path: "Animal.xn", text: "public class Animal {}" },
    { path: "Cage.xn", text: `public class Cage<T extends Animal> {
  public final value:T
  public function Cage(value:T) { this.value = value }
}` },
    { path: "BadChild.xn", text: "public class BadChild<T> extends Cage<T> {}" },
    { path: "Main.xn", text: `typedef Reader<T extends Animal> = (value:T) -> T
public class Main {
  public function Main() {
    var explicit:Cage<String> = new Cage('x')
    var inferred = new Cage('y')
    var reader:Reader<String> = (value:String):String => value
  }
}` },
  ], { main: "Main" });
  expect(constraintErrors(result)).toEqual([
    "type argument `T` does not satisfy constraint `Animal`",
    "type argument `String` does not satisfy constraint `Animal`",
    "type argument `String` does not satisfy constraint `Animal`",
    "type argument `String` does not satisfy constraint `Animal`",
    "type argument `String` does not satisfy constraint `Animal`",
  ]);
});

test("defaults are checked and constraints compose through another constrained parameter", () => {
  const result = compileProject([
    { path: "Animal.xn", text: "public class Animal {}" },
    { path: "BadDefault.xn", text: "public class BadDefault<T extends Animal = String> {}" },
    { path: "GoodDefault.xn", text: "public class GoodDefault<T extends Animal = Animal> {}" },
    { path: "Forwarder.xn", text: `public class Forwarder<T extends Animal> extends GoodDefault<T> {
  public function Forwarder() {}
}` },
    { path: "Main.xn", text: "public class Main { public function Main() {} }" },
  ], { main: "Main" });
  expect(constraintErrors(result)).toEqual([
    "type argument `String` does not satisfy constraint `Animal`",
  ]);
});

test("method constraints are specialized through inherited generic classes", () => {
  const result = compileProject([
    { path: "Animal.xn", text: "public class Animal {}" },
    { path: "Dog.xn", text: "public class Dog extends Animal {}" },
    { path: "Base.xn", text: `public class Base<T> {
  public function keep<U extends T>(value:U):U => value
}` },
    { path: "Child.xn", text: "public class Child extends Base<Animal> {}" },
    { path: "Main.xn", text: `public class Main {
  public function Main() {
    var child = new Child()
    var dog:Dog = child.keep(new Dog())
    var invalid:String = child.keep('x')
  }
}` },
  ], { main: "Main" });
  expect(constraintErrors(result)).toEqual([
    "type argument `String` does not satisfy constraint `Animal`",
  ]);
});

test("direct cycles between type parameter constraints are rejected", () => {
  const result = compileProject([
    { path: "Main.xn", text: `public class Main<T extends U, U extends T> {
  public function Main() {}
}` },
  ], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.code === "X0881").map((d) => d.message)).toEqual([
    "generic constraint cycle: `T` extends `U` extends `T`",
  ]);
});

test("generic interface implementations cannot narrow the interface's constraint", () => {
  const result = compileProject([
    { path: "Animal.xn", text: "public class Animal {}" },
    { path: "Dog.xn", text: "public class Dog extends Animal {}" },
    { path: "Consumer.xn", text: "public interface Consumer { function accept<T>(value:T):T }" },
    { path: "AnimalConsumer.xn", text: "public class AnimalConsumer implements Consumer { public function accept<T extends Animal>(value:T):T => value }" },
    { path: "Main.xn", text: "public class Main { public function Main() {} }" },
  ], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.code === "X0788").map((d) => d.message)).toEqual([
    "`AnimalConsumer.accept` doesn't match `Consumer.accept`",
  ]);
});

test("constraints are preserved in TypeScript for all generic declarations", () => {
  const result = compileProject([
    { path: "Animal.xn", text: "public class Animal {}" },
    { path: "Box.xn", text: `public class Box<T extends Animal = Animal> {
  public var value:T?
  public function map<U extends T>(value:U):U => value
}` },
    { path: "Main.xn", text: `typedef Reader<T extends Animal> = (value:T) -> T
public class Main {
  public function Main() {}
  public function choose<T extends Animal>(value:T):T => value
}` },
  ], { main: "Main", target: "ts" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error")).toEqual([]);
  const box = result.outputs.find((o) => o.path === "Box.ts")!.text;
  const main = result.outputs.find((o) => o.path === "Main.ts")!.text;
  expect(box).toContain("class Box<T extends Animal = Animal>");
  expect(box).toContain("map<U extends T>(value: U): U");
  expect(main).toContain("type Reader<T extends Animal>");
  expect(main).toContain("choose<T extends Animal>(value: T): T");
  expect(typeCheck(result.outputs, join(import.meta.dir, ".constraints-ts"))).toEqual([]);
});

const NAMED_SIZED = [
  { path: "INamed.xn", text: "public interface INamed { function get name():String }" },
  { path: "ISized.xn", text: "public interface ISized { function get size():Int }" },
  { path: "Doc.xn", text: `public class Doc implements INamed, ISized {
  public function Doc() {}
  public function get name():String => 'doc'
  public function get size():Int => 3
  public var label:String = 'L'
}` },
  { path: "OnlyNamed.xn", text: "public class OnlyNamed implements INamed { public function OnlyNamed() {} public function get name():String => 'n' }" },
];

test("intersection constraints: `T extends A & B` sees every bound's members and fits each bound", () => {
  const result = compileProject([
    ...NAMED_SIZED,
    { path: "Box.xn", text: `public class Box<T extends INamed & ISized> {
  private var item:T
  public function Box(item:T) { this.item = item }
  public function describe():String => item.name + ':' + item.size
  public function named():INamed => item
  public function sized():ISized => item
}` },
    { path: "Main.xn", text: `public class Main {
  public function Main() {}
  public static function both<T extends INamed & ISized>(x:T):String => x.name + x.size
  public static function labelled<T extends INamed & { label:String }>(x:T):String => x.label + x.name
  public static function total<T extends INamed & ISized>(xs:Array<T>):Int {
    var sum = 0
    for (var x of xs) sum += x.size
    return sum
  }
  public static function run():String => both(new Doc()) + labelled(new Doc()) + new Box(new Doc()).describe() + total([new Doc()])
}` },
  ], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error")).toEqual([]);
});

test("intersection constraints: every bound is checked; a member must come from one of them", () => {
  const result = compileProject([
    ...NAMED_SIZED,
    { path: "Box.xn", text: "public class Box<T extends INamed & ISized> { public function Box() {} }" },
    { path: "Main.xn", text: `public class Main {
  public function Main() {
    trace(both(new OnlyNamed()), new Box<OnlyNamed>())
  }
  public static function both<T extends INamed & ISized>(x:T):String => x.name + x.missing
  public static function asString<T extends INamed & ISized>(x:T):String => x
}` },
  ], { main: "Main" });
  expect(constraintErrors(result)).toEqual([
    "type argument `OnlyNamed` does not satisfy constraint `ISized`",
    "type argument `OnlyNamed` does not satisfy constraint `ISized`",
  ]);
  const x0880 = result.diagnostics.items.find((d) => d.code === "X0880")!;
  expect(x0880.notes).toContain("`T` must satisfy every bound: `INamed & ISized`");
  const missing = result.diagnostics.items.find((d) => d.code === "X0426")!;
  expect(missing.message).toBe("no member `missing` on type parameter `T`");
  expect(result.diagnostics.items.some((d) => d.code === "X0308")).toBe(true); // `T` isn't a `String`
});

test("intersection constraints: an implementation may not add a bound the interface doesn't have", () => {
  const result = compileProject([
    ...NAMED_SIZED,
    { path: "Reader.xn", text: "public interface Reader { function read<T extends INamed & ISized>(x:T):String; function peek<T extends INamed>(x:T):String }" },
    { path: "Impl.xn", text: `public class Impl implements Reader {
  public function Impl() {}
  public function read<T extends ISized & INamed>(x:T):String => x.name   // the same bounds, reordered: fine
  public function peek<T extends INamed & ISized>(x:T):String => x.name   // stricter
}` },
    { path: "Main.xn", text: "public class Main { public function Main() {} }" },
  ], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.code === "X0788").map((d) => d.message)).toEqual([
    "`Impl.peek` doesn't match `Reader.peek`",
  ]);
});

test("intersection constraints are TypeScript intersections", () => {
  const result = compileProject([
    ...NAMED_SIZED,
    { path: "Main.xn", text: `public class Main {
  public function Main() {}
  public static function both<T extends INamed & ISized>(x:T):String => x.name + x.size
  public static function labelled<T extends INamed & { label:String }>(x:T):String => x.label
}` },
  ], { main: "Main", target: "ts" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error")).toEqual([]);
  const main = result.outputs.find((o) => o.path === "Main.ts")!.text;
  expect(main).toContain("both<T extends INamed & ISized>(x: T): string");
  expect(main).toContain("labelled<T extends INamed & { label: string }>(x: T): string");
  expect(typeCheck(result.outputs, join(import.meta.dir, ".constraints-ts"))).toEqual([]);
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(join(import.meta.dir, ".constraints-ts"), { recursive: true, force: true });
});
