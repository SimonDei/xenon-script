/**
 * The error code catalog behind `klass explain <code>`. Every code the compiler emits must have
 * an entry (enforced by tests/codes.test.ts).
 */
export interface CodeInfo {
  title: string;
  explanation: string;
  /** Code that triggers the diagnostic and a corrected version. */
  example?: { wrong: string; right: string };
}

const c = (title: string, explanation: string, wrong?: string, right?: string): CodeInfo =>
  wrong && right ? { title, explanation, example: { wrong, right } } : { title, explanation };

export const CODES: Record<string, CodeInfo> = {
  // ---- project structure ----
  K0001: c("main class not found", "The program starts by creating the main class (`--main`, default `Main`). No public class with that qualified name exists in the source root."),
  K0003: c("no source files", "The source root contains no `.kl` files. Check `--src` or `\"src\"` in klass.json."),
  K0004: c("main class is not public", "The main class is instantiated by the generated entry module, so it must be `public`.",
    "package {\n  class Main {}\n}", "package {\n  public class Main {}\n}"),
  K0005: c("main constructor has required parameters", "The program starts with `new Main()`; there is nothing to pass to required parameters. Give them default values or remove them."),
  K0010: c("missing package block", "A file in a folder below the source root starts with a `package` block naming that folder: `src/com/zoo/Dog.kl` is `package com.zoo { … }`. Only files directly in the source root (the top-level package) may leave the block out.",
    "// src/com/zoo/Dog.kl\npublic class Dog {}", "// src/com/zoo/Dog.kl\npackage com.zoo {\n  public class Dog {}\n}"),
  K0020: c("package doesn't match directory", "A file's package must match its directory below the source root: `src/com/zoo/Dog.kl` declares `package com.zoo`."),
  K0021: c("more than one definition in a package block", "A package block holds one definition, named like the file. Helper classes go after the package block, where they are file-private."),
  K0022: c("definition not named like its file", "The definition inside the package block must have the file's name: `class Dog` lives in `Dog.kl`."),
  K0023: c("invalid class visibility", "Classes are `public` (usable from other packages) or `internal` (the default, package only)."),
  K0024: c("defined twice", "Two definitions have the same qualified name."),
  K0025: c("visibility on a file-private class", "Classes after the package block are only visible in their file; a visibility modifier makes no sense there."),
  K0026: c("names differ only in letter case", "Two classes would compile to modules whose paths differ only in case, which collide on case-insensitive file systems and in Bun's module cache."),
  K0027: c("reserved package name", "The package `klass` belongs to the built-in prelude."),
  K0028: c("built-in class name", "Names like `Exception` or `IDisposable` are built-in classes available everywhere; pick another name."),

  // ---- syntax ----
  K0100: c("syntax error", "The parser expected something else at this point. The label says what was expected."),
  K0101: c("unclosed delimiter", "A `(`, `[` or `{` was never closed. The secondary label shows where it was opened."),
  K0102: c("missing statement end", "Statements end with `;` or a line break. Two statements on one line need a `;` between them.",
    "var a:int = 1 var b:int = 2", "var a:int = 1; var b:int = 2"),
  K0103: c("several visibility modifiers", "A declaration has exactly one of `public`, `internal`, `protected`, `private`."),
  K0104: c("duplicate modifier", "The same modifier is written twice."),
  K0105: c("invalid assignment target", "Only variables, members (`obj.x`) and indexed elements (`a[i]`) can be assigned to."),
  K0106: c("`for each` syntax", "Klass iterates values with `for (var v:T of collection)`.",
    "for each (var d:Dog in dogs) {}", "for (var d:Dog of dogs) {}"),
  K0107: c("binding keyword in a condition", "A binding in `if (…)` / `while (…)` uses `var`."),

  // ---- declarations ----
  K0201: c("duplicate member", "A class declares two members with the same name (getter/setter pairs excepted). Klass has no overloading."),
  K0202: c("several constructors", "A class has at most one constructor; use default parameter values instead of overloads."),
  K0203: c("constructor return type", "Constructors don't declare a return type."),
  K0204: c("name already declared", "A variable with this name already exists in the same scope."),
  K0205: c("getter with parameters", "Getters take no parameters."),
  K0206: c("setter parameter count", "Setters take exactly one parameter: the new value."),
  K0207: c("getter/setter type mismatch", "A getter and its setter must use the same type."),
  K0208: c("rest parameter not last", "`...rest` collects the remaining arguments, so it must be the last parameter."),
  K0209: c("rest parameter type", "A rest parameter is an `Array`: `...names:Array<String>` (a bare `Array` takes any values)."),
  K0210: c("required parameter after optional", "Parameters with default values must come after the required ones."),
  K0211: c("setter return type", "A setter's return type is `void`."),
  K0212: c("getter/setter visibility differ", "A getter and its setter must have the same visibility."),

  // ---- types and expressions ----
  K0308: c("mismatched types", "A value's type doesn't fit where it is used. Klass converts nothing implicitly except `int`/`uint` → `Float`; use `int()`, `Float()`, `String()` and the like.",
    "var half:int = total / 2", "var half:int = int(total / 2)"),
  K0309: c("comparison is always false (or true)", "`==` never converts between types, so values of unrelated types (or a non-nullable type and `null`) can never be equal.",
    "if (count == '3') {}", "if (count == 3) {}"),
  K0310: c("condition is not a Boolean", "Klass has no truthiness: conditions must be `Boolean`. Compare explicitly.",
    "if (items.length) {}", "if (items.length != 0) {}"),
  K0311: c("void value used", "A call to a `void` method has no value."),
  K0312: c("value returned from a void function", "This function (or constructor) is `void` and can't return a value."),
  K0313: c("missing return value", "A non-void function must return a value; a line break directly after `return` ends the statement.",
    "return\n  a + b", "return a + b"),
  K0314: c("not all paths return a value", "Execution can reach the end of a non-void function without a `return`."),
  K0315: c("operator not applicable", "The operator isn't defined for these operand types (no implicit conversions, no truthiness)."),
  K0316: c("invalid delete", "`delete` removes properties of dynamic (`*`/`Object`) values only."),
  K0317: c("`??` has no effect", "The left side can never be null, so `??` never uses its right side."),
  K0318: c("incompatible `?:` branches", "The two branches of a conditional expression must have compatible types."),
  K0319: c("case can never match", "The `case` value's type can never equal the `switch` value."),
  K0320: c("binding type can't be null", "`if (var x:T = …)` tests for null; a non-nullable type like `int` would always pass."),
  K0321: c("binding refers to itself", "The bound value mentions an outer variable with the same name, which would be shadowed. Rename the binding."),
  K0322: c("assignment used as a condition", "`=` assigns. To compare use `==`; to bind and test a value use `if (var x:T = …)`.",
    "if (done = true) {}", "if (done == true) {}"),
  K0330: c("invalid range step", "A range `step` is a positive compile-time constant; ranges never count down."),
  K0331: c("empty range", "The range's start isn't below its end, so the loop never runs. Ranges count up only."),
  K0332: c("range variable assigned", "The variable of a range loop is read-only."),
  K0333: c("range outside a loop", "Ranges (`0..10`) are only allowed as the source of `for (… of …)`."),
  K0334: c("non-integer range", "Range bounds are `int`/`uint` and the loop variable is a number."),
  K0335: c("misplaced spread", "`...` spreads only into calls, array literals and object literals."),
  K0340: c("`break` outside a loop", "`break` leaves the innermost loop or `switch`; there is none here."),
  K0341: c("`continue` outside a loop", "`continue` needs an enclosing loop (`switch` doesn't count)."),
  K0343: c("duplicate case", "Two `case` labels have the same constant value."),
  K0344: c("several defaults", "A `switch` has at most one `default`."),

  // ---- literals ----
  K0350: c("bad regex flag", "Valid regular expression flags are d g i m s u v y, each at most once."),
  K0351: c("invalid regular expression", "The pattern is not a valid JavaScript regular expression."),
  K0352: c("unterminated regex", "A `~/…/` literal needs a closing `/` on the same line."),
  K0360: c("foreign string syntax", "Strings use single quotes; template strings are `$'…{expr}…'`.",
    "trace(\"hi \" + `${name}`)", "trace('hi ' + $'{name}')"),
  K0361: c("unknown escape", "Valid escapes: \\' \\\\ \\n \\r \\t \\0 \\b \\f \\v \\xFF \\uFFFF \\u{1F600} \\{ \\}."),
  K0362: c("unterminated string", "Strings can't span lines; use `\\n` for a line break."),
  K0363: c("unterminated comment", "A `/*` comment was never closed."),
  K0364: c("unexpected character", "This character can't appear in Klass code."),
  K0365: c("invalid number", "The number literal is malformed (e.g. letters directly after digits)."),
  K0366: c("unclosed interpolation", "A `{` inside a `$'…'` template has no matching `}`."),
  K0367: c("empty interpolation", "`{}` inside a template string needs an expression; write `\\{` for a literal brace."),
  K0370: c("`+` not defined for a class", "Adding objects is only possible when the left operand's class declares `operator+` (or one side is a `String`)."),
  K0371: c("unsupported operator", "Only `operator+` can be overloaded for now."),
  K0372: c("invalid `operator+`", "`operator+` takes exactly one required parameter (the right operand) and returns a value."),
  K0373: c("static `operator+`", "`operator+` is an instance method: it's called on the left operand."),
  K0380: c("call-style casts", "AS3's `Dog(x)` cast isn't supported; use `x as Dog`, which gives `null` for other types.",
    "var d:Dog = Dog(pet)", "var d:Dog = pet as Dog"),
  K0390: c("Object isn't iterable", "Plain objects can't be used with `of`; iterate `Object.values(obj)` or `Object.keys(obj)`."),
  K0391: c("not iterable", "`for (… of …)` needs an iterable: Array, String, Map, Set, `*`."),
  K0392: c("no keys to iterate", "`for (… in …)` needs an object."),
  K0393: c("`as` with a non-nullable type", "`as` gives `null` for other types, which `int`/`Float`/`Boolean` can't hold. Convert with `int(x)` or test with `x is int`."),
  K0394: c("type can't be tested at runtime", "`is`/`as` need a runtime check; `Array<T>` element types and `*` have none (`is Array` works)."),
  K0396: c("impossible type test", "The value's static type can never be the tested type."),
  K0397: c("unnecessary test or cast", "The value already has this type, so the `is` test is true (unless null) and the `as` cast does nothing."),

  // ---- names and members ----
  K0410: c("instance member in a static context", "Static code has no `this`, so instance members can't be used there."),
  K0411: c("`this`/`super` in a static context", "Static code has no `this`."),
  K0413: c("static member through an instance", "Static members are accessed through the class name."),
  K0414: c("instance member through the class", "Instance members need an instance."),
  K0415: c("not instantiable", "Only classes (and class values held in variables) can be used with `new`."),
  K0420: c("type not found", "No type with this name is visible. Check the spelling and imports; `Number` is called `Float`, `Error` is `Exception`."),
  K0421: c("misplaced void", "`void` is only a return type."),
  K0422: c("wrong number of type arguments", "A generic type needs one type argument per type parameter, e.g. `Map<String, int>`; `Array<T>` takes one (a bare `Array` is `Array<*>`)."),
  K0424: c("`Vector` is `Array<T>`", "Klass has one array type: `Array<T>` with the element type (a bare `Array` is `Array<*>`, any elements).", "var names:Vector<String> = []", "var names:Array<String> = []"),
  K0423: c("unexpected type arguments", "Only generic types take type arguments: `Array<T>` and classes declared with type parameters, like `Promise<T>` or `Map<K, V>`."),
  K0425: c("name not found", "No variable, member, class or import with this name is in scope."),
  K0426: c("member not found", "The type has no member with this name."),
  K0427: c("member of null", "`null` has no members."),
  K0430: c("package not found", "No classes exist in this package."),
  K0431: c("import not found", "No class or typedef has this qualified name."),
  K0432: c("name imported twice", "Two imports provide the same simple name; use a qualified name for one of them."),
  K0433: c("ambiguous name", "Several wildcard imports provide this name. Import the one you mean explicitly."),
  K0434: c("file-private name clash", "A file-private class has the same name as a class in the package."),
  K0435: c("file-private import", "Classes after the package block can only be used in their own file."),
  K0441: c("not visible outside its package", "The class or typedef is `internal` to its package; mark it `public` to use it elsewhere."),

  // ---- assignment and definite assignment ----
  K0501: c("assigned twice", "`const` and `final` values can be assigned only once.",
    "final id:String = 'a'\nid = 'b'", "var id:String = 'a'\nid = 'b'"),
  K0502: c("final field assigned outside its constructor", "A `final` field is assigned in its own class's constructor (or a `static { }` block for static ones)."),
  K0503: c("uninitialized constant", "`const` needs a value where it is declared; `final` can be assigned later."),
  K0504: c("read-only property", "The property has a getter but no setter."),
  K0505: c("assignment to a method", "Methods can't be replaced."),
  K0506: c("write-only property", "The property has a setter but no getter."),
  K0510: c("used before assignment", "The `final` value is read before anything was assigned to it."),
  K0511: c("possibly unassigned", "The `final` value is assigned on some paths but not on all paths reaching this read."),
  K0512: c("possibly assigned twice", "An earlier path may already have assigned this `final` value."),
  K0513: c("final assigned in a loop or function", "A loop or closure could run more than once and assign the `final` value repeatedly."),
  K0514: c("final not always assigned", "A `final` field must be assigned on every path through the constructor (or the static blocks)."),
  K0515: c("final field never assigned", "The class has no constructor to assign this `final` field; give it a value."),
  K0520: c("misplaced `inline`", "`inline` applies to `static final`/`static const` fields and local `final`/`const` values."),
  K0521: c("`inline var`", "Inline constants never change: use `final` or `const`."),
  K0522: c("inline without value", "An inline constant needs a value to paste."),
  K0523: c("not a compile-time constant", "Inline values may only use literals, other inline constants, enum members, operators and the conversion functions."),
  K0524: c("inline cycle", "Inline constants refer to each other in a circle."),
  K0525: c("inline value doesn't fit", "The folded value doesn't fit the declared type (e.g. `7 / 2` is 3.5, not an `int`)."),

  // ---- calls and access ----
  K0601: c("wrong number of arguments", "The call passes more or fewer arguments than the function accepts."),
  K0602: c("not callable", "Only functions and methods can be called."),
  K0603: c("not accessible", "The member is `private` (its class only), `protected` (class and subclasses) or `internal` (its package) and can't be used here.",
    "trace(dog._name)", "trace(dog.name)"),
  K0604: c("no overload matches", "None of the native member's signatures accepts these arguments; the notes list them."),
  K0607: c("method closure through `?.`", "A method used as a value is bound to its object, which `?.` may not have."),

  // ---- inheritance ----
  K0700: c("can't be extended", "Only classes can be extended (not interfaces, enums or other types)."),
  K0701: c("inheritance cycle", "Classes or interfaces extend each other in a circle."),
  K0702: c("final class extended", "`final` classes can't have subclasses."),
  K0710: c("abstract class instantiated", "Abstract classes are only instantiated through concrete subclasses."),
  K0711: c("abstract members not implemented", "A concrete class must implement every abstract member it inherits (with `override`)."),
  K0712: c("abstract member in a concrete class", "Only `abstract` classes can have abstract members."),
  K0713: c("abstract member with a body", "Abstract members have no body; subclasses provide it."),
  K0714: c("method without a body", "Only abstract and interface members may omit the body."),
  K0715: c("misplaced `abstract`", "Fields and constructors can't be abstract."),
  K0716: c("invalid abstract member", "Abstract members can't be `static`, `final`, `inline` or `private`."),
  K0717: c("abstract and final", "An abstract class must be extended, which `final` forbids."),
  K0718: c("calling an abstract member through super", "The parent's member is abstract; there is no implementation to call."),
  K0720: c("missing `override`", "A member that replaces an inherited one must be marked `override`, so shadowing is never accidental.",
    "public function speak():String { … }", "override public function speak():String { … }"),
  K0721: c("`override` without an original", "Nothing with this name is inherited from a superclass (interface members are implemented without `override`)."),
  K0722: c("override doesn't match", "An override keeps the parameters, visibility, `async`/`const` and kind of the original; the return type may be narrower."),
  K0723: c("final member overridden", "`final` members can't be overridden."),
  K0724: c("field redeclared", "Fields can't be overridden or redeclared in subclasses."),
  K0725: c("static/instance conflict", "A static and an instance member can't share a name across the hierarchy."),
  K0726: c("override on a field", "Only methods and accessors can be overridden."),
  K0731: c("missing `super(...)`", "The parent's constructor needs arguments, so the constructor must call `super(...)` first."),
  K0732: c("misplaced `super(...)`", "`super(...)` is the first statement of a constructor."),
  K0733: c("no superclass", "The class extends nothing, so there's no `super`."),
  K0734: c("bare `super`", "`super` is only used as `super(...)` or `super.member`."),
  K0735: c("field through `super`", "Fields live on the instance; read them with `this.x`."),
  K0736: c("`this` before `super(...)`", "The object doesn't exist until the parent constructor returns."),
  K0737: c("`super` in a function expression", "`function(){}` has its own `this`; use an arrow function."),
  K0738: c("member access from a function expression in a field initializer", "There's no method to capture `this` from; use an arrow function."),

  // ---- exceptions and async ----
  K0750: c("throwing a non-exception", "Only `Exception`s (and subclasses) can be thrown.",
    "throw 'failed'", "throw new Exception('failed')"),
  K0751: c("catching a non-exception", "Catch clauses name `Exception` or a subclass."),
  K0752: c("`catch (e:*)`", "Everything caught is normalized to an `Exception`; catch `Exception`."),
  K0753: c("unreachable catch", "An earlier clause already catches this type."),
  K0760: c("`await` outside async", "`await` (and `await using`) need an `async` function.",
    "function load():Promise<int> { return await f() }", "async function load():Promise<int> { return await f() }"),
  K0761: c("invalid async", "Constructors and accessors can't be `async`."),
  K0762: c("awaiting a plain value", "The value isn't a Promise; `await` just returns it."),
  K0763: c("async return type", "An async function returns `Promise<T>`."),

  // ---- destructuring ----
  K0770: c("can't destructure", "Only objects can be destructured with `{…}`, and only arrays/vectors/strings with `[…]`."),
  K0771: c("destructuring a method", "A method taken out of its object would lose `this`; call it instead."),

  // ---- interfaces and typedefs ----
  K0780: c("interface member with a body", "Interfaces only declare signatures."),
  K0781: c("interface field", "Interfaces can't have fields; declare a getter."),
  K0782: c("invalid interface member", "Interface members are public instance methods/accessors without other modifiers."),
  K0783: c("interface extends a non-interface", "Interfaces extend interfaces only."),
  K0784: c("implementing a non-interface", "Only interfaces are implemented; classes are extended."),
  K0785: c("extending an interface", "Classes implement interfaces with `implements`."),
  K0786: c("interface instantiated", "Instantiate a class that implements the interface."),
  K0787: c("interface member not implemented", "A class must implement every member of its interfaces (abstract classes may leave them to subclasses)."),
  K0788: c("implementation doesn't match", "The implementation must be public, non-static and have the interface's signature."),
  K0789: c("interface listed twice", "The same interface appears twice in `implements`/`extends`."),
  K0790: c("typedef refers to itself", "A typedef can only refer to itself inside a shape member, e.g. `{ value:int, ?next:Node }`."),
  K0791: c("unknown member in object literal", "A fresh object literal can only have the members of its shape type.",
    "var p:Point = { x: 1, yy: 2 }", "var p:Point = { x: 1, y: 2 }"),
  K0792: c("missing members in object literal", "Required (non-`?`) members of the shape are missing."),
  K0793: c("read-only shape member", "The member is declared `final` in the shape."),
  K0794: c("structural type at runtime", "Typedef shapes and function types are erased; `is` can't test them (`as` is an unchecked cast)."),
  K0795: c("duplicate shape member", "A shape lists the same member twice."),

  // ---- native declarations ----
  K0820: c("code in a native class", "`native` classes only describe existing JavaScript classes: no bodies, static blocks or destructors."),
  K0821: c("value on a native field", "A native field's value comes from JavaScript; it can't have an initial value."),

  // ---- generics ----
  K0796: c("duplicate type parameter", "A type parameter list names the same parameter twice."),
  K0797: c("type argument can't be inferred", "Type arguments of generic calls and `new` are inferred from the arguments (or the expected type). When nothing determines one, pass an argument that does, assign the result to a typed variable, or write the arguments for `new`.",
    "var b:* = new Box()", "var b:Box<int> = new Box()"),

  // ---- destructors ----
  K0800: c("invalid destructor placement", "A class has at most one destructor; interfaces have none."),
  K0801: c("disposable never disposed", "The object has a destructor, which only runs through `using` or `dispose()`.",
    "var f:File = new File('a')", "using f:File = new File('a')"),
  K0802: c("not disposable", "`using` needs a value whose class has a destructor `~Name()`."),
  K0803: c("destructor name", "A destructor is named `~ClassName`."),
  K0804: c("invalid destructor", "Destructors take no parameters, have no return type, are public or protected, and take no other modifiers."),
  K0805: c("`dispose()` clash", "A destructor provides `dispose()`; the class can't declare its own."),
  K0806: c("sync/async destructor mismatch", "A destructor must be async exactly when its parent's is, since they run as a chain."),
  K0807: c("async resource without `await using`", "A value with an async destructor is held with `await using`."),
  K0808: c("IDisposable implemented by hand", "Declare a destructor instead; it provides `dispose()` and works with `using`."),

  // ---- enums ----
  K0811: c("invalid enum value", "Enum values are all `int`s or all `String`s."),
  K0812: c("enum member without value", "Members of string enums, and members after a non-numeric value, need explicit values."),
  K0813: c("duplicate enum value", "Two members of an enum have the same value."),
  K0814: c("non-exhaustive switch over an enum", "The `switch` has no `default` and misses some members."),
  K0815: c("enum instantiated", "Enum values are its members, e.g. `Direction.Up`."),
  K0816: c("`values` in an enum", "`values` is the built-in `Enum.values()`."),
  K0817: c("non-constant enum value", "Enum values are compile-time constants."),

  // ---- compatibility and style warnings ----
  K0840: c("`undefined` used", "Klass has one \"no value\": `null`. `undefined` exists for JavaScript compatibility; `x == null` matches both.",
    "if (x == undefined) {}", "if (x == null) {}"),
  K0841: c("`===` used", "`==` and `!=` are already strict in Klass."),
  K0850: c("missing type annotation", "Klass doesn't infer declaration types; without an annotation a declaration is `*` (dynamic, unchecked).",
    "var count = 0", "var count:int = 0"),
  K0860: c("unreachable code", "The statement follows a `return`, `throw`, `break` or `continue` and never runs."),
  K0861: c("unused variable", "The local variable or local function is never read. Remove it, or start its name with `_` to mark it as intentionally unused."),
  K0862: c("unused private member", "Nothing refers to this private member."),
  K0870: c("unused import", "Nothing in the file uses this import."),
  K0871: c("duplicate import", "The class is imported twice."),
  K0872: c("import from the own package", "Classes of the same package are visible without an import."),

  // ---- const methods ----
  K0901: c("change in a const method", "A `const` method doesn't change the object: no field or setter writes through `this`.",
    "public function count():int const { calls++; return n }", "public function count():int const { return n }"),
  K0902: c("non-const use in a const method", "A `const` method can only use const methods and getters on `this`."),
  K0903: c("invalid `const`", "Static methods, setters and constructors can't be `const`."),
};

/** Text for `klass explain <code>`. */
export function explain(code: string): string | undefined {
  const info = CODES[code.toUpperCase()];
  if (!info) return undefined;
  const lines = [`${code.toUpperCase()}: ${info.title}`, "", info.explanation];
  if (info.example) {
    lines.push("", "Example:", "", ...info.example.wrong.split("\n").map((l) => `    ${l}`), "", "Fixed:", "", ...info.example.right.split("\n").map((l) => `    ${l}`));
  }
  return lines.join("\n") + "\n";
}
