// A plain JavaScript library kept next to the Xenon sources (as one would keep `xlsx.js`).
export function book() {
  return { names: [], sheets: {} };
}

export function addSheet(book, name, rows) {
  book.names.push(name);
  book.sheets[name] = rows;
}

export function toCsv(book, name) {
  return book.sheets[name].map((row) => row.join(",")).join("\n");
}

export class Cell {
  constructor(value) {
    this.value = value;
  }
  get kind() {
    return typeof this.value;
  }
}
