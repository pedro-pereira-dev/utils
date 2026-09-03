import { open, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api.js";

export class ConversionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  override toString(): string {
    return `${this.code}: ${this.message}`;
  }
}

export interface Word {
  text: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  page: number;
}

interface VisualLine {
  page: number;
  top: number;
  words: readonly Word[];
}

interface Columns {
  amountStart: number;
}

interface RawBlock {
  page: number;
  index: number;
  lines: readonly VisualLine[];
  columns: Columns;
}

export interface RawTransaction {
  page: number;
  index: number;
  movementToken: string;
  valueToken: string;
  description: string;
  unsignedAmount: number;
  resultingBalance: number;
}

export interface Transaction {
  movementDate: Date;
  description: string;
  amount: number;
  resultingBalance: number;
}

export interface Statement {
  periodStart: Date;
  periodEnd: Date;
  openingBalance: number;
  closingBalance: number;
  transactions: readonly Transaction[];
}

export interface ConversionResult {
  outputPath: string;
  statement: Statement;
}

const DATE_TOKEN_RE = /^\d{2}-\d{2}-(?:\d{2}|\d{4})$/;
const MONEY_RE = /^(?:0|[1-9]\d{0,2}(?:\.\d{3})*|[1-9]\d*),\d{2}$/;
const PERIOD_RE =
  /\bPERIODO\s+DE\s+(\d{2}-\d{2}-(?:\d{2}|\d{4}))\s+A\s+(\d{2}-\d{2}-(?:\d{2}|\d{4}))\b/g;
const BALANCE_RE = /SALDO\s+CONTABILISTICO\s+EM\s+\d{2}-\d{2}-(?:\d{2}|\d{4})/;
const LINE_TOLERANCE = 2.5;

export function normalizeMarker(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().trim().split(/\s+/).join(" ");
}

export function normalizeDescription(value: string): string {
  return value.trim().split(/\s+/).join(" ");
}

export function parseMoney(value: string): number {
  value = value.trim();
  if (!MONEY_RE.test(value)) {
    throw new ConversionError(
      "MALFORMED_ROW",
      `invalid Portuguese monetary value ${JSON.stringify(value)}`,
    );
  }
  const [euros, cents] = value.replaceAll(".", "").split(",");
  return Number(euros) * 100 + Number(cents);
}

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function makeDate(year: number, month: number, day: number, source: string): Date {
  const result = new Date(Date.UTC(year, month - 1, day));
  if (
    result.getUTCFullYear() !== year ||
    result.getUTCMonth() !== month - 1 ||
    result.getUTCDate() !== day
  ) {
    throw new ConversionError("MALFORMED_ROW", `invalid date ${JSON.stringify(source)}`);
  }
  return result;
}

export function parseStatementDate(value: string, periodYear?: number): Date {
  if (!DATE_TOKEN_RE.test(value)) {
    throw new ConversionError("MALFORMED_ROW", `invalid date ${JSON.stringify(value)}`);
  }
  const parts = value.split("-");
  const day = Number(parts[0]);
  const month = Number(parts[1]);
  const yearToken = parts[2]!;
  if (
    yearToken.length === 2 &&
    (periodYear === undefined || Number(yearToken) !== periodYear % 100)
  ) {
    throw new ConversionError(
      "MALFORMED_ROW",
      `date year ${JSON.stringify(value)} does not match statement year`,
    );
  }
  return makeDate(yearToken.length === 2 ? periodYear! : Number(yearToken), month, day, value);
}

function parsePeriodDates(startToken: string, endToken: string): [Date, Date] {
  const startYear = startToken.split("-").at(-1)!;
  const endYear = endToken.split("-").at(-1)!;
  if (startYear.length !== endYear.length) {
    throw new ConversionError(
      "AMBIGUOUS_PERIOD",
      "statement period uses inconsistent year formats",
    );
  }
  if (startYear.length === 2) {
    if (startYear !== endYear) {
      throw new ConversionError("AMBIGUOUS_PERIOD", "cross-year statement periods are unsupported");
    }
    const year = 2000 + Number(startYear);
    return [parseStatementDate(startToken, year), parseStatementDate(endToken, year)];
  }
  return [parseStatementDate(startToken), parseStatementDate(endToken)];
}

function parseValueDate(value: string, periodYear: number): Date {
  const yearToken = value.split("-").at(-1)!;
  if (yearToken.length === 4) return parseStatementDate(value);
  const years = [periodYear - 1, periodYear, periodYear + 1].filter(
    (year) => year % 100 === Number(yearToken),
  );
  if (years.length !== 1) {
    throw new ConversionError(
      "MALFORMED_ROW",
      `value date year ${JSON.stringify(value)} is ambiguous`,
    );
  }
  return parseStatementDate(value, years[0]);
}

export function inferSignedAmount(previous: number, unsigned: number, resulting: number): number {
  const credit = previous + unsigned === resulting;
  const debit = previous - unsigned === resulting;
  if (credit === debit) {
    throw new ConversionError(
      "ROW_RECONCILIATION_FAILED",
      "running balance does not identify exactly one debit or credit",
    );
  }
  return credit ? unsigned : -unsigned;
}

function monthKey(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function dateToIso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function deriveOutputPath(
  periodStart: Date,
  periodEnd: Date,
  outputDirectory = process.cwd(),
): string {
  if (monthKey(periodStart) !== monthKey(periodEnd)) {
    throw new ConversionError("AMBIGUOUS_PERIOD", "cross-month statement periods are unsupported");
  }
  return join(outputDirectory, `${monthKey(periodStart)}-statements.csv`);
}

export function groupWords(words: readonly Word[]): readonly VisualLine[] {
  const sorted = [...words].sort((a, b) => a.page - b.page || a.top - b.top || a.x0 - b.x0);
  const lines: Word[][] = [];
  for (const word of sorted) {
    const line = lines.at(-1);
    if (!line || word.page !== line[0]!.page || Math.abs(word.top - line[0]!.top) > LINE_TOLERANCE)
      lines.push([word]);
    else line.push(word);
  }
  return lines.map((line) => ({
    page: line[0]!.page,
    top: Math.min(...line.map((word) => word.top)),
    words: [...line].sort((a, b) => a.x0 - b.x0),
  }));
}

function lineText(line: VisualLine): string {
  return line.words.map((word) => word.text).join(" ");
}

function findPeriod(documentText: string): [Date, Date] {
  const matches = [...normalizeMarker(documentText).matchAll(PERIOD_RE)].map(
    (match) => `${match[1]}|${match[2]}`,
  );
  const unique = [...new Set(matches)];
  if (unique.length !== 1)
    throw new ConversionError("AMBIGUOUS_PERIOD", "expected exactly one statement period");
  const [startToken, endToken] = unique[0]!.split("|") as [string, string];
  const [start, end] = parsePeriodDates(startToken, endToken);
  if (start > end || monthKey(start) !== monthKey(end)) {
    throw new ConversionError("AMBIGUOUS_PERIOD", "statement period must cover one calendar month");
  }
  return [start, end];
}

function isTransactionStart(line: VisualLine): boolean {
  return (
    line.words.length >= 2 &&
    DATE_TOKEN_RE.test(line.words[0]!.text) &&
    DATE_TOKEN_RE.test(line.words[1]!.text)
  );
}

function columnsFromHeader(line: VisualLine): Columns | undefined {
  const normalized = line.words.map((word) => normalizeMarker(word.text));
  const amountWords = line.words.filter(
    (_, index) => normalized[index] === "DEBITO" || normalized[index] === "CREDITO",
  );
  const valueWords = line.words.filter((_, index) => normalized[index] === "VALOR");
  if (amountWords.length === 0 || valueWords.length === 0) return undefined;
  const balanceHeader = valueWords.reduce((maximum, word) =>
    word.x0 > maximum.x0 ? word : maximum,
  );
  const amountStart = Math.min(...amountWords.map((word) => word.x0));
  const balanceStart = (Math.max(...amountWords.map((word) => word.x1)) + balanceHeader.x0) / 2;
  return amountStart < balanceStart ? { amountStart } : undefined;
}

function balanceValue(line: VisualLine): number {
  const money = line.words.filter((word) => MONEY_RE.test(word.text));
  if (money.length !== 1) {
    throw new ConversionError(
      "AMBIGUOUS_BALANCE",
      `page ${line.page}: accounting balance is ambiguous`,
    );
  }
  return parseMoney(money[0]!.text);
}

function extractBlocks(lines: readonly VisualLine[]): [number, number, readonly RawBlock[]] {
  let columns: Columns | undefined;
  let opening: number | undefined;
  let closing: number | undefined;
  let current: VisualLine[] = [];
  const blocks: RawBlock[] = [];
  let inTable = false;
  const appendCurrent = (): void => {
    if (!columns)
      throw new ConversionError("UNSUPPORTED_LAYOUT", "transaction columns were not found");
    blocks.push({ page: current[0]!.page, index: blocks.length + 1, lines: current, columns });
    current = [];
  };

  for (const line of lines) {
    const headerColumns = columnsFromHeader(line);
    if (headerColumns) {
      columns = headerColumns;
      continue;
    }
    if (BALANCE_RE.test(normalizeMarker(lineText(line)))) {
      if (opening === undefined) {
        opening = balanceValue(line);
        inTable = true;
        continue;
      }
      if (current.length > 0) appendCurrent();
      closing = balanceValue(line);
      inTable = false;
      break;
    }
    if (!inTable) continue;
    if (isTransactionStart(line)) {
      if (current.length > 0) appendCurrent();
      current = [line];
    } else if (current.length > 0 && line.page === current.at(-1)!.page) {
      current.push(line);
    }
  }
  if (opening === undefined || closing === undefined) {
    throw new ConversionError(
      "AMBIGUOUS_BALANCE",
      "expected one opening and one closing accounting balance",
    );
  }
  if (blocks.length === 0)
    throw new ConversionError("MALFORMED_ROW", "statement contains no transactions");
  return [opening, closing, blocks];
}

function parseBlock(block: RawBlock): RawTransaction {
  const first = block.lines[0]!;
  const allWords = block.lines.flatMap((line) => line.words);
  const moneyWords = allWords
    .filter((word) => MONEY_RE.test(word.text))
    .sort((a, b) => a.x0 - b.x0);
  if (moneyWords.length < 2) {
    throw new ConversionError(
      "MALFORMED_ROW",
      `page ${block.page}, transaction ${block.index}: expected one amount and one running balance`,
    );
  }
  const [amountWord, balanceWord] = moneyWords.slice(-2);
  const excluded = new Set([first.words[0], first.words[1], amountWord, balanceWord]);
  const description = normalizeDescription(
    allWords
      .filter((word) => !excluded.has(word) && word.x1 <= block.columns.amountStart)
      .map((word) => word.text)
      .join(" "),
  );
  if (!description)
    throw new ConversionError(
      "MALFORMED_ROW",
      `page ${block.page}, transaction ${block.index}: empty description`,
    );
  return {
    page: block.page,
    index: block.index,
    movementToken: first.words[0]!.text,
    valueToken: first.words[1]!.text,
    description,
    unsignedAmount: parseMoney(amountWord!.text),
    resultingBalance: parseMoney(balanceWord!.text),
  };
}

export function buildStatement(
  periodStart: Date,
  periodEnd: Date,
  opening: number,
  closing: number,
  rawTransactions: readonly RawTransaction[],
): Statement {
  let previous = opening;
  const transactions: Transaction[] = [];
  for (const raw of rawTransactions) {
    const movementDate = parseStatementDate(raw.movementToken, periodStart.getUTCFullYear());
    parseValueDate(raw.valueToken, periodStart.getUTCFullYear());
    if (movementDate < periodStart || movementDate > periodEnd) {
      throw new ConversionError(
        "MALFORMED_ROW",
        `page ${raw.page}, transaction ${raw.index}: movement date is outside the statement period`,
      );
    }
    let signed: number;
    try {
      signed = inferSignedAmount(previous, raw.unsignedAmount, raw.resultingBalance);
    } catch (error) {
      if (!(error instanceof ConversionError)) throw error;
      throw new ConversionError(
        error.code,
        `page ${raw.page}, transaction ${raw.index}: ${error.message}`,
        { cause: error },
      );
    }
    transactions.push({
      movementDate,
      description: raw.description,
      amount: signed,
      resultingBalance: raw.resultingBalance,
    });
    previous = raw.resultingBalance;
  }
  const total = transactions.reduce((sum, transaction) => sum + transaction.amount, 0);
  if (previous !== closing || opening + total !== closing) {
    throw new ConversionError(
      "STATEMENT_RECONCILIATION_FAILED",
      "transaction total does not reach the closing balance",
    );
  }
  return { periodStart, periodEnd, openingBalance: opening, closingBalance: closing, transactions };
}

export function parseExtractedDocument(
  pageWords: readonly (readonly Word[])[],
  pageTexts: readonly string[],
): Statement {
  const documentText = pageTexts.join("\n");
  const normalized = normalizeMarker(documentText);
  if (!normalized)
    throw new ConversionError("UNSUPPORTED_PDF", "PDF has no usable native text layer");
  const required = ["EXTRACTO INTEGRADO", "APLICACOES", "DEPOSITOS A ORDEM"];
  if (required.some((marker) => !normalized.includes(marker))) {
    throw new ConversionError(
      "UNSUPPORTED_LAYOUT",
      "required statement section markers were not found",
    );
  }
  const [periodStart, periodEnd] = findPeriod(documentText);
  const [opening, closing, blocks] = extractBlocks(groupWords(pageWords.flat()));
  return buildStatement(periodStart, periodEnd, opening, closing, blocks.map(parseBlock));
}

export async function extractPdf(inputPath: string): Promise<Statement> {
  let loadingTask: ReturnType<typeof getDocument> | undefined;
  try {
    loadingTask = getDocument({
      data: new Uint8Array(await readFile(inputPath)),
    });
    const pdf = await loadingTask.promise;
    if (pdf.numPages === 0) throw new ConversionError("UNSUPPORTED_PDF", "PDF contains no pages");
    const pageTexts: string[] = [];
    const pageWords: Word[][] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items.filter((item): item is TextItem => "str" in item);
      const pageHeight = page.view[3]!;
      pageTexts.push(items.map((item) => item.str).join(" "));
      pageWords.push(
        items
          .filter((item) => item.str.trim())
          .map((item) => {
            const height = Math.hypot(item.transform[2], item.transform[3]);
            return {
              text: item.str,
              x0: item.transform[4],
              x1: item.transform[4] + item.width,
              top: pageHeight - item.transform[5] - height,
              bottom: pageHeight - item.transform[5],
              page: pageNumber,
            };
          }),
      );
    }
    return parseExtractedDocument(pageWords, pageTexts);
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ConversionError("UNSUPPORTED_PDF", `cannot read PDF: ${message}`, { cause: error });
  } finally {
    await loadingTask?.destroy();
  }
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export async function writeCsv(statement: Statement, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const rows = [
    "movement_date,description,amount",
    ...statement.transactions.map((transaction) =>
      [
        dateToIso(transaction.movementDate),
        csvField(transaction.description),
        formatMoney(transaction.amount),
      ].join(","),
    ),
  ];
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(`${rows.join("\n")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if (error instanceof ConversionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ConversionError("IO_ERROR", `cannot write output: ${message}`, { cause: error });
  }
}

export async function convertStatement(
  inputPath: string,
  outputDirectory = process.cwd(),
): Promise<ConversionResult> {
  try {
    if (!(await stat(inputPath)).isFile()) throw new Error("not a file");
  } catch {
    throw new ConversionError(
      "UNSUPPORTED_PDF",
      `input does not exist or is not a file: ${inputPath}`,
    );
  }
  const statement = await extractPdf(inputPath);
  const destination = deriveOutputPath(statement.periodStart, statement.periodEnd, outputDirectory);
  await writeCsv(statement, destination);
  return { outputPath: destination, statement };
}
