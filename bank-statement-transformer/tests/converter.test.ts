import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  buildStatement,
  ConversionError,
  deriveOutputPath,
  formatMoney,
  inferSignedAmount,
  normalizeDescription,
  parseExtractedDocument,
  parseMoney,
  parseStatementDate,
  writeCsv,
} from "@/converter";
import type { RawTransaction, Statement, Word } from "@/converter";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function date(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function expectConversionError(code: string, action: () => unknown): void {
  assert.throws(action, (error) => error instanceof ConversionError && error.code === code);
}

function word(
  text: string,
  x0: number,
  top: number,
  page = 1,
  width = Math.max(8, text.length * 4),
): Word {
  return { text, x0, x1: x0 + width, top, bottom: top + 8, page };
}

test("parses Portuguese monetary values as integer cents", () => {
  for (const [source, expected] of [
    ["0,01", 1],
    ["8,15", 815],
    ["2.000,00", 200000],
    ["164.397,61", 16439761],
  ] as const) {
    assert.equal(parseMoney(source), expected);
  }
});

test("rejects malformed monetary values", () => {
  for (const source of ["1.23,45", "01,00", "1,2", "1,000.00", "-1,00", "1 000,00"]) {
    expectConversionError("MALFORMED_ROW", () => parseMoney(source));
  }
});

test("uses the statement year for short dates", () => {
  assert.equal(parseStatementDate("03-08-26", 2026).getTime(), date(2026, 8, 3).getTime());
  assert.equal(parseStatementDate("03-08-2026", 2026).getTime(), date(2026, 8, 3).getTime());
  expectConversionError("MALFORMED_ROW", () => parseStatementDate("03-08-25", 2026));
});

test("accepts a value date in the previous year", () => {
  const raw: RawTransaction[] = [
    {
      page: 1,
      index: 1,
      movementToken: "01-01-26",
      valueToken: "31-12-25",
      description: "DEBIT",
      unsignedAmount: 100,
      resultingBalance: 9900,
    },
  ];
  const statement = buildStatement(date(2026, 1, 1), date(2026, 1, 31), 10000, 9900, raw);
  assert.equal(statement.transactions[0]!.movementDate.getTime(), date(2026, 1, 1).getTime());
});

test("infers debit and credit from running balances", () => {
  assert.equal(inferSignedAmount(474735, 815, 473920), -815);
  assert.equal(inferSignedAmount(406569, 200000, 606569), 200000);
  expectConversionError("ROW_RECONCILIATION_FAILED", () => inferSignedAmount(10000, 100, 10050));
  expectConversionError("ROW_RECONCILIATION_FAILED", () => inferSignedAmount(10000, 0, 10000));
});

test("normalizes descriptions and formats amounts", () => {
  assert.equal(normalizeDescription("  COMPRA\tPADARIA   42  "), "COMPRA PADARIA 42");
  assert.equal(formatMoney(-1), "-0.01");
  assert.equal(formatMoney(200000), "2000.00");
});

test("derives the default output from the statement period", () => {
  assert.equal(
    deriveOutputPath(date(2026, 8, 1), date(2026, 8, 31), "/tmp"),
    "/tmp/2026-08-statements.csv",
  );
  expectConversionError("AMBIGUOUS_PERIOD", () =>
    deriveOutputPath(date(2026, 8, 1), date(2026, 9, 1)),
  );
});

test("reconciles every row and the statement total", () => {
  const raw: RawTransaction[] = [
    {
      page: 1,
      index: 1,
      movementToken: "01-08-26",
      valueToken: "31-07-26",
      description: "DEBIT",
      unsignedAmount: 815,
      resultingBalance: 473920,
    },
    {
      page: 1,
      index: 2,
      movementToken: "02-08-26",
      valueToken: "02-08-26",
      description: "CREDIT",
      unsignedAmount: 200000,
      resultingBalance: 673920,
    },
  ];
  const statement = buildStatement(date(2026, 8, 1), date(2026, 8, 31), 474735, 673920, raw);
  assert.deepEqual(
    statement.transactions.map((transaction) => transaction.amount),
    [-815, 200000],
  );
  const validRow = {
    page: 1,
    index: 1,
    movementToken: "01-08-26",
    valueToken: "01-08-26",
    description: "DEBIT",
    unsignedAmount: 100,
    resultingBalance: 9900,
  };
  expectConversionError("STATEMENT_RECONCILIATION_FAILED", () =>
    buildStatement(date(2026, 8, 1), date(2026, 8, 31), 10000, 9800, [validRow]),
  );
});

test("coordinate pipeline supports wrapped descriptions", () => {
  const text =
    "EXTRACTO INTEGRADO\nAPLICAÇÕES\nDEPÓSITOS A ORDEM PARTICULARES\nPeríodo de 01-08-2026 a 31-08-2026";
  const words = [
    word("Data", 10, 10),
    word("Mov.", 30, 10),
    word("Data", 70, 10),
    word("Valor", 100, 10),
    word("Descritivo", 145, 10),
    word("Débito", 350, 10),
    word("Crédito", 410, 10),
    word("Valor", 543, 10),
    word("Saldo", 10, 30),
    word("Contabilístico", 40, 30),
    word("em", 100, 30),
    word("31-07-2026", 120, 30),
    word("1.000,00", 530, 30),
    word("01-08-26", 10, 50),
    word("31-07-26", 70, 50),
    word("COMPRA", 145, 50),
    word("COM", 190, 50),
    word("100,00", 350, 50),
    word("900,00", 530, 50),
    word("DESCRICAO", 145, 62),
    word("LONGA", 200, 62),
    word("02-08-26", 10, 80),
    word("02-08-26", 70, 80),
    word("TRANSFERENCIA", 145, 80),
    word("200,00", 410, 80),
    word("1.100,00", 530, 80),
    word("Saldo", 10, 100),
    word("Contabilístico", 40, 100),
    word("em", 100, 100),
    word("31-08-2026", 120, 100),
    word("1.100,00", 530, 100),
  ];
  const statement = parseExtractedDocument([words], [text]);
  assert.deepEqual(
    statement.transactions.map((transaction) => transaction.description),
    ["COMPRA COM DESCRICAO LONGA", "TRANSFERENCIA"],
  );
  assert.deepEqual(
    statement.transactions.map((transaction) => transaction.amount),
    [-10000, 20000],
  );
});

test("supports two-digit statement period years", () => {
  const text =
    "EXTRACTO INTEGRADO\nAPLICACOES\nDEPOSITOS A ORDEM PARTICULARES\nPeriodo de 01-08-26 a 31-08-26";
  const words = [
    word("Descritivo", 145, 10),
    word("Debito", 350, 10),
    word("Credito", 410, 10),
    word("Valor", 543, 10),
    word("Saldo", 10, 30),
    word("Contabilistico", 40, 30),
    word("em", 100, 30),
    word("31-07-2026", 120, 30),
    word("100,00", 530, 30),
    word("01-08-26", 10, 50),
    word("01-08-26", 70, 50),
    word("CREDITO", 145, 50),
    word("1,00", 410, 50),
    word("101,00", 530, 50),
    word("Saldo", 10, 70),
    word("Contabilistico", 40, 70),
    word("em", 100, 70),
    word("31-08-2026", 120, 70),
    word("101,00", 530, 70),
  ];
  assert.equal(
    parseExtractedDocument([words], [text]).periodStart.getTime(),
    date(2026, 8, 1).getTime(),
  );
});

test("supports wide running balances that extend into the amount boundary", () => {
  const text =
    "EXTRACTO INTEGRADO\nAPLICACOES\nDEPOSITOS A ORDEM PARTICULARES\nPeriodo de 01-08-26 a 31-08-26";
  const words = [
    word("Descritivo", 145, 10),
    word("Debito", 350, 10),
    word("Credito", 410, 10),
    word("Valor", 543, 10),
    word("Saldo", 10, 30),
    word("Contabilistico", 40, 30),
    word("em", 100, 30),
    word("31-07-2026", 120, 30),
    word("94.642,21", 525, 30),
    word("01-08-26", 10, 50),
    word("01-08-26", 70, 50),
    word("ORDENADOS", 145, 50),
    word("5.586,01", 470, 50),
    word("100.228,22", 520, 50),
    word("Saldo", 10, 70),
    word("Contabilistico", 40, 70),
    word("em", 100, 70),
    word("31-08-2026", 120, 70),
    word("100.228,22", 520, 70),
  ];

  assert.equal(parseExtractedDocument([words], [text]).transactions[0]!.amount, 558601);
});

test("supports wide amounts that extend left of the amount boundary", () => {
  const text =
    "EXTRACTO INTEGRADO\nAPLICACOES\nDEPOSITOS A ORDEM PARTICULARES\nPeriodo de 01-08-26 a 31-08-26";
  const words = [
    word("Descritivo", 145, 10),
    word("Debito", 414, 10),
    word("Credito", 473, 10),
    word("Valor", 544, 10),
    word("Saldo", 10, 30),
    word("Contabilistico", 40, 30),
    word("em", 100, 30),
    word("31-07-2026", 120, 30),
    word("263.391,73", 519, 30),
    word("01-08-26", 10, 50),
    word("01-08-26", 70, 50),
    word("TRANSFERENCIA", 145, 50),
    word("250.000,00", 398, 50),
    word("13.391,73", 525, 50),
    word("Saldo", 10, 70),
    word("Contabilistico", 40, 70),
    word("em", 100, 70),
    word("31-08-2026", 120, 70),
    word("13.391,73", 525, 70),
  ];

  assert.equal(parseExtractedDocument([words], [text]).transactions[0]!.amount, -25000000);
});

test("writes byte-stable RFC-compatible CSV atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "statement-test-"));
  temporaryDirectories.push(directory);
  const statement: Statement = {
    periodStart: date(2026, 8, 1),
    periodEnd: date(2026, 8, 31),
    openingBalance: 10000,
    closingBalance: 10001,
    transactions: [
      {
        movementDate: date(2026, 8, 1),
        description: 'LOJA, "CENTRO"',
        amount: 1,
        resultingBalance: 10001,
      },
    ],
  };
  const first = join(directory, "first.csv");
  const second = join(directory, "second.csv");
  await writeCsv(statement, first);
  await writeCsv(statement, second);
  assert.deepEqual(await readFile(first), await readFile(second));
  assert.equal(
    (await readFile(first)).toString(),
    'movement_date,description,amount\n2026-08-01,"LOJA, ""CENTRO""",0.01\n',
  );
  const replacement = { ...statement, transactions: [] };
  await writeCsv(replacement, first);
  assert.equal((await readFile(first)).toString(), "movement_date,description,amount\n");
});

test("rejects a PDF extraction without native text", () => {
  expectConversionError("UNSUPPORTED_PDF", () => parseExtractedDocument([[]], [""]));
});
