// Xenon prelude sources are imported as text (`import x from "./X.xn" with { type: "text" }`).
declare module "*.xn" {
  const text: string;
  export default text;
}
