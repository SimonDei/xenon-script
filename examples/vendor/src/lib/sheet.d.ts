/** A workbook: sheet names in order, rows by sheet name. */
export interface Book {
  names: string[];
  sheets: { [name: string]: any[][] };
}

/** A new, empty workbook. */
export function book(): Book;
/** Adds a sheet (its rows: arrays of cell values) under `name`. */
export function addSheet(book: Book, name: string, rows: any[][]): void;
/** One sheet as comma-separated lines. */
export function toCsv(book: Book, name: string): string;

export class Cell {
  constructor(value: string | number);
  readonly value: string | number;
  /** `'string'` or `'number'`. */
  get kind(): string;
}
