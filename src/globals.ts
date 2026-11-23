/**
 * JavaScript globals usable from Xenon code, all typed `*` (A0/A7): the ones the standard library
 * (src/prelude/std) doesn't declare yet. `Error` and its subclasses are deliberately absent (A6c),
 * and so are the global number functions and values (`GLOBAL_HINTS`): `parseInt`, `isNaN`, … coerce
 * their argument, the `Float` statics don't.
 */
export const JS_GLOBALS = new Set([
  "WeakMap", "WeakSet",
  "WeakRef", "Proxy", "Reflect", "Intl", "BigInt", "ArrayBuffer", "DataView", "Uint8Array", "Int8Array",
  "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array", "TextEncoder", "TextDecoder",
  "URL", "URLSearchParams", "AbortController", "AbortSignal", "Blob", "FormData", "Headers", "Request", "Response",
  "globalThis", "process", "Bun", "window", "navigator", "location", "localStorage", "performance",
  "crypto",
  "EventTarget", "Event", "CustomEvent", "MessageChannel", "MessagePort", "BroadcastChannel", "WebSocket", "Worker",
  "ReadableStream", "WritableStream", "TransformStream", "File", "FileReader", "FinalizationRegistry",
  "AsyncDisposableStack", "DisposableStack", "requestAnimationFrame", "cancelAnimationFrame", "alert", "HTMLElement",
  "CSSStyleDeclaration",
]);

/** Browser globals with a concrete prelude type instead of `*`. */
export const TYPED_GLOBALS = new Map([
  ["document", "xenon.Document"],
]);

/** Hidden JS globals and what to use instead (reported as a hint on "cannot find"). */
export const GLOBAL_HINTS: Record<string, { use: string; note?: string }> = {
  parseInt: { use: "Float.parseInt" },
  parseFloat: { use: "Float.parseFloat" },
  isNaN: { use: "Float.isNaN", note: "the global `isNaN` converts its argument first (`isNaN('abc')` is true); `Float.isNaN` doesn't" },
  isFinite: { use: "Float.isFinite", note: "the global `isFinite` converts its argument first; `Float.isFinite` doesn't" },
  NaN: { use: "Float.NaN", note: "test for it with `Float.isNaN(x)`: `x == NaN` is always false" },
  Infinity: { use: "Float.POSITIVE_INFINITY" },
};
