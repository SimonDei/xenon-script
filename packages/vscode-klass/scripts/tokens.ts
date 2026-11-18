import { join } from "node:path";
import * as oniguruma from "vscode-oniguruma";
import { INITIAL, parseRawGrammar, Registry } from "vscode-textmate";
// Prints the TextMate scopes of each token: bun packages/vscode-klass/scripts/tokens.ts "<line>" …
const root = join(import.meta.dir, "..", "..", "..");
const gp = join(root, "packages/vscode-klass/syntaxes/klass.tmLanguage.json");
await oniguruma.loadWASM(await Bun.file(join(root, "node_modules/vscode-oniguruma/release/onig.wasm")).arrayBuffer());
const reg = new Registry({ onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new oniguruma.OnigScanner(p), createOnigString: (s: string) => new oniguruma.OnigString(s) }), loadGrammar: async () => parseRawGrammar(await Bun.file(gp).text(), gp) });
const g = (await reg.loadGrammar("source.klass"))!;
for (const line of process.argv.slice(2)) {
  const r = g.tokenizeLine(line, INITIAL);
  console.log(line); for (const t of r.tokens) console.log("  ", JSON.stringify(line.slice(t.startIndex, t.endIndex)), t.scopes.slice(1).join(" "));
}
