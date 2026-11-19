// A small JavaScript library kept in the source folder: copied next to the bundle, not bundled.
export function format(cents, currency) {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
