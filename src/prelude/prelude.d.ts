// Klass prelude sources are imported as text (`import x from "./X.kl" with { type: "text" }`).
declare module "*.kl" {
  const text: string;
  export default text;
}
