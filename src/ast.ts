import type { SourceFile, Span } from "./source.ts";

export interface Ident {
  name: string;
  span: Span;
}

/** A declared type parameter; a class's may have a default: `class Event<T = EventTarget>`. */
export interface TypeParam extends Ident {
  constraint?: TypeNode;
  default?: TypeNode;
  variance?: "in" | "out";
}

/* ---------------------------- types ---------------------------- */

export interface ShapeMemberNode {
  name: Ident;
  type: TypeNode;
  optional: boolean;
  readonly: boolean;
  span: Span;
}

export type TypeNode =
  | { kind: "TypeName"; name: Ident[]; args: TypeNode[]; span: Span } // Dog, com.zoo.Dog, Array<int>
  | { kind: "AnyType"; span: Span } // *
  | { kind: "VoidType"; span: Span }
  | { kind: "NullableType"; inner: TypeNode; span: Span } // int?
  | { kind: "UnionType"; types: TypeNode[]; span: Span } // int | String, 'utf8' | 'ascii' | null
  | { kind: "NullType"; span: Span } // `null`, as a member of a union
  /** `true`, `'buffer'`, `1`, `-1`, `0.5` (a value as a type); `float`: a number written with a fraction or exponent. */
  | { kind: "LiteralType"; value: boolean | string | number; float?: boolean; span: Span }
  | { kind: "ShapeType"; members: ShapeMemberNode[]; span: Span } // { x:Float, ?label:String }
  | { kind: "FunctionType"; params: { name?: Ident; type: TypeNode; rest: boolean; span: Span }[]; ret: TypeNode; span: Span }; // (a:int) -> int

/* ---------------------------- files ---------------------------- */

export interface XenonImport {
  kind: "XenonImport";
  path: Ident[];
  wildcard: boolean;
  span: Span;
}

export interface JsImport {
  kind: "JsImport";
  defaultName?: Ident;
  namespace?: Ident;
  named: { name: Ident; alias?: Ident }[];
  module: string;
  span: Span;
}

export type Import = XenonImport | JsImport;

export interface Modifiers {
  visibility?: { value: "public" | "private" | "protected" | "internal"; span: Span };
  static?: Span;
  final?: Span;
  override?: Span;
  inline?: Span;
  /** `static constexpr function`: evaluated at compile time when its arguments are constants. */
  constexpr?: Span;
  /** `static consteval function`: every call must be evaluated at compile time. */
  consteval?: Span;
  abstract?: Span;
  dynamic?: Span;
  async?: Span;
  /** `native` / `native('JsName')`: describes an existing JS class; no code is generated. */
  native?: Span;
  nativeName?: string;
}

export interface Param {
  name: Ident;
  type?: TypeNode;
  init?: Expr;
  rest: boolean;
  final: boolean;
  span: Span;
}

export interface Field {
  kind: "Field";
  attributes?: Attribute[];
  modifiers: Modifiers;
  decl: "var" | "const" | "final";
  name: Ident;
  type?: TypeNode;
  init?: Expr;
  span: Span;
  /** The storage of a property with accessors (`var label:String { set => … }`): the property's name. */
  storageOf?: string;
}

/**
 * `[Route('/', verb = 'POST')]` before a class, method or field: an instance of the attribute class
 * `name`, created with `args` and then given the `named` values (see src/attributes.ts).
 */
export interface Attribute {
  name: TypeNode & { kind: "TypeName" };
  args: Expr[];
  named: { name: Ident; value: Expr; span: Span }[];
  span: Span;
}

export interface Method {
  kind: "Method";
  attributes?: Attribute[];
  modifiers: Modifiers;
  name: Ident;
  /** `function map<U>(…)` */
  typeParams?: TypeParam[];
  accessor?: "get" | "set";
  isConstructor: boolean;
  /** `~Name()` — runs on `dispose()` / at the end of a `using` scope. */
  isDestructor?: boolean;
  params: Param[];
  returnType?: TypeNode;
  isConst: boolean;
  body?: Block;
  span: Span;
  /** Written with an expression body (`function area():Float => w * h`); `body` holds its one statement. */
  exprBody?: boolean;
  /** An accessor of a property declared with `var x:T { get => …; set => … }` (desugared by the parser). */
  property?: boolean;
}

/** `static { … }` — runs once when the class is defined. */
export interface StaticBlock {
  kind: "StaticBlock";
  modifiers: Modifiers;
  body: Block;
  span: Span;
}

export type Member = Field | Method | StaticBlock;

export interface ClassDecl {
  kind: "Class";
  attributes?: Attribute[];
  /** `class Box<T, U>`, `class Event<T = EventTarget>` */
  typeParams?: TypeParam[];
  /** `interface`: no bodies or fields; `implements` then lists the interfaces it extends. */
  isInterface?: boolean;
  /** `enum`: members are synthesized static `const` fields (in order), plus a static `values()`. */
  isEnum?: boolean;
  modifiers: Modifiers;
  name: Ident;
  extends?: TypeNode;
  implements: TypeNode[];
  members: Member[];
  span: Span;
}

/** `typedef Name = Type` — a compile-time name for a type. */
export interface TypedefDecl {
  kind: "Typedef";
  modifiers: Modifiers;
  name: Ident;
  typeParams?: TypeParam[];
  type: TypeNode;
  span: Span;
}

export type TypeDecl = ClassDecl | TypedefDecl;

export interface XenonFile {
  file: SourceFile;
  /** Dotted package name; `[]` for the top-level package. */
  packageName: Ident[];
  packageSpan?: Span;
  imports: Import[];
  /** Definitions inside the package block. */
  decls: TypeDecl[];
  /** File-private definitions after the package block. */
  privateDecls: TypeDecl[];
  /** `native function name(…):T` at package level: an existing JS function (standard library only, X0029). */
  functions: Method[];
}

/* -------------------------- statements -------------------------- */

export interface Block {
  kind: "Block";
  body: Stmt[];
  span: Span;
}

export interface VarDecl {
  kind: "VarDecl";
  decl: "var" | "const" | "final";
  /** `inline const`/`inline final`: folded at compile time and pasted at every use. */
  inline?: Span;
  name: Ident;
  type?: TypeNode;
  init?: Expr;
  span: Span;
}

/**
 * Destructuring pattern. Declarations bind names (`BindingName`); destructuring assignments
 * store into existing places (`Target`: a name, `obj.x` or `a[i]`). `init` is a default value.
 */
export type Pattern =
  | { kind: "BindingName"; name: Ident; init?: Expr; span: Span }
  | { kind: "Target"; expr: Expr; init?: Expr; span: Span }
  | { kind: "ObjectPattern"; props: { key: Ident; value: Pattern; span: Span }[]; rest?: Pattern; init?: Expr; span: Span }
  | { kind: "ArrayPattern"; elements: (Pattern | null)[]; rest?: Pattern; init?: Expr; span: Span };

/** Item of an `if (var …)` / `while (var …)` header: a null-checked binding or a plain condition. */
export type HeaderItem =
  | { kind: "Binding"; name: Ident; type?: TypeNode; init: Expr; span: Span }
  | { kind: "Cond"; expr: Expr; span: Span };

/** Loop variable declared in a `for (… in/of …)` header. */
export interface LoopVar {
  decl: "var" | "const" | "final";
  name: Ident;
  /** `for (var [k, v] of map)`: a destructuring pattern instead of a single name. */
  pattern?: Pattern;
  type?: TypeNode;
  span: Span;
}

export type ComprehensionClause =
  | { kind: "For"; variable: LoopVar; iterable: Expr }
  | ({ kind: "ForRange"; variable: LoopVar } & RangeBounds)
  | { kind: "If"; cond: Expr };

export interface RangeBounds {
  start: Expr;
  end?: Expr;
  inclusive: boolean;
  step?: Expr;
}

export interface SwitchCase {
  /** `undefined` for `default:`. */
  test?: Expr;
  body: Stmt[];
  span: Span;
}

export type UsingResource =
  | { kind: "Decl"; name: Ident; type?: TypeNode; init: Expr; span: Span }
  | { kind: "Expr"; expr: Expr; span: Span };

export interface CatchClause {
  name: Ident;
  /** `undefined` means `Exception`. */
  type?: TypeNode;
  body: Block;
  span: Span;
}

export type Stmt =
  | Block
  | { kind: "Try"; block: Block; catches: CatchClause[]; finally?: Block; span: Span }
  | { kind: "FuncDecl"; fn: FunctionNode & { name: Ident; body: Block }; span: Span }
  | { kind: "DestructDecl"; decl: "var" | "const" | "final"; pattern: Pattern; type?: TypeNode; init: Expr; span: Span }
  /** `[await] using name:T = expr` — disposed when the enclosing block ends. */
  | { kind: "UsingDecl"; isAwait: boolean; name: Ident; type?: TypeNode; init: Expr; span: Span }
  /** `[await] using (a:T = e, …) body` or `using (expr) body`. */
  | { kind: "UsingBlock"; isAwait: boolean; resources: UsingResource[]; body: Stmt; span: Span }
  /** `defer body`: `body` runs when the enclosing block ends, however it ends (the last `defer` first). */
  | { kind: "Defer"; body: Stmt; span: Span }
  | VarDecl
  | { kind: "IfVar"; header: HeaderItem[]; then: Stmt; else?: Stmt; span: Span }
  | { kind: "WhileVar"; header: HeaderItem[]; body: Stmt; span: Span }
  | { kind: "For"; init?: VarDecl | { kind: "ExprStmt"; expr: Expr; span: Span }; cond?: Expr; update?: Expr; body: Stmt; span: Span }
  | { kind: "ForIn"; variable: LoopVar; object: Expr; body: Stmt; span: Span }
  | { kind: "ForOf"; variable: LoopVar; iterable: Expr; body: Stmt; span: Span }
  | ({ kind: "ForRange"; variable: LoopVar; body: Stmt; span: Span } & RangeBounds)
  | { kind: "Switch"; discriminant: Expr; cases: SwitchCase[]; span: Span }
  | { kind: "ExprStmt"; expr: Expr; span: Span }
  /** `lineBreakBefore`: the next line looks like a value that was meant to be returned. */
  | { kind: "Return"; value?: Expr; lineBreakBefore?: Span; span: Span }
  | { kind: "If"; cond: Expr; then: Stmt; else?: Stmt; span: Span }
  | { kind: "While"; cond: Expr; body: Stmt; span: Span }
  | { kind: "DoWhile"; body: Stmt; cond: Expr; span: Span }
  | { kind: "Break"; span: Span }
  | { kind: "Continue"; span: Span }
  | { kind: "Throw"; value: Expr; span: Span }
  | { kind: "Empty"; span: Span };

/* -------------------------- expressions -------------------------- */

/** A function expression `function(…) {…}`, an arrow `(…) => …`, or a local `function name(…) {…}`. */
export interface FunctionNode {
  kind: "Function";
  arrow: boolean;
  async: boolean;
  name?: Ident;
  typeParams?: TypeParam[];
  params: Param[];
  returnType?: TypeNode;
  /** Arrow functions may have an expression body. */
  body: Block | Expr;
  span: Span;
}

export type TemplateExprPart = { kind: "text"; value: string } | { kind: "expr"; expr: Expr };

export type Expr =
  | { kind: "Ident"; name: string; span: Span }
  | { kind: "This"; span: Span }
  | { kind: "Super"; span: Span }
  | { kind: "Number"; raw: string; value: number; span: Span }
  | { kind: "String"; value: string; span: Span }
  | { kind: "Template"; parts: TemplateExprPart[]; span: Span }
  | { kind: "Regex"; pattern: string; flags: string; span: Span }
  | { kind: "Bool"; value: boolean; span: Span }
  | { kind: "Null"; span: Span }
  | { kind: "Undefined"; span: Span }
  | { kind: "Array"; elements: Expr[]; span: Span }
  | { kind: "Comprehension"; clauses: ComprehensionClause[]; value: Expr; span: Span }
  | { kind: "Object"; props: ObjectProp[]; span: Span }
  | { kind: "Spread"; arg: Expr; span: Span }
  | { kind: "Member"; object: Expr; name: Ident; optional: boolean; span: Span }
  /** `Type::member`: an unbound member value whose first parameter is the receiver. */
  | { kind: "PropertyReference"; owner: Expr; name: Ident; span: Span }
  | { kind: "Index"; object: Expr; index: Expr; optional: boolean; span: Span }
  | { kind: "Call"; callee: Expr; args: Expr[]; optional: boolean; span: Span }
  /** `nameof(target)`: checked source-level name, folded to a string constant. */
  | { kind: "Nameof"; args: Expr[]; span: Span }
  | { kind: "New"; callee: TypeNode; args: Expr[]; span: Span }
  | { kind: "Unary"; op: string; arg: Expr; span: Span }
  | { kind: "Update"; op: "++" | "--"; prefix: boolean; arg: Expr; span: Span }
  | { kind: "Binary"; op: string; left: Expr; right: Expr; opSpan: Span; span: Span }
  | { kind: "Assign"; op: string; target: Expr; value: Expr; opSpan: Span; span: Span }
  | { kind: "Conditional"; cond: Expr; then: Expr; else: Expr; span: Span }
  | { kind: "TypeOp"; op: "is" | "as"; expr: Expr; type: TypeNode; span: Span }
  /** `(expr : Type)`: a compile-time type check (no runtime effect): `expr` is typed against `Type`, the result is a `Type`. */
  | { kind: "TypeCheck"; expr: Expr; type: TypeNode; span: Span }
  | { kind: "Await"; arg: Expr; span: Span }
  | { kind: "DestructAssign"; pattern: Pattern; value: Expr; span: Span }
  | FunctionNode
  | { kind: "Error"; span: Span };

export type ObjectProp =
  /** `method`: written `function name(…) {…}` (the value is that function). */
  | { kind: "Prop"; key: Ident | { kind: "Computed"; expr: Expr } | { kind: "StringKey"; value: string }; value: Expr; method?: boolean; span: Span }
  /** `function get area():Int {…}` / `function set area(v:Int) {…}` in an object literal. */
  | { kind: "Accessor"; accessor: "get" | "set"; key: Ident; fn: FunctionNode; span: Span }
  | { kind: "Shorthand"; name: Ident; span: Span }
  | { kind: "SpreadProp"; arg: Expr; span: Span };
