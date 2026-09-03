#!/usr/bin/env node
import { parseArgs } from "node:util";

import { ConversionError, convertStatement, dateToIso, formatMoney } from "@/converter";

const usage = `usage: npm run transform [--output PATH] [--verbose] INPUT.pdf [...]`;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let values: { output?: string; verbose: boolean; help: boolean };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: "string" },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    values = parsed.values as typeof values;
    positionals = parsed.positionals;
  } catch (error) {
    console.error(`${usage}\n${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  let outputDirectory = values.output;
  if (!outputDirectory && process.env.npm_config_output) {
    outputDirectory =
      process.env.npm_config_output === "true" ? positionals.pop() : process.env.npm_config_output;
  }
  if (values.help) {
    console.log(`${usage}\n\nConverts a supported native-text statement PDF to reconciled CSV.`);
    return 0;
  }
  if (positionals.length === 0) {
    console.error(`${usage}\nAt least one input PDF is required.`);
    return 2;
  }
  let failed = false;
  for (const input of positionals) {
    try {
      const result = await convertStatement(input, outputDirectory);
      if (values.verbose) {
        const statement = result.statement;
        const net = statement.transactions.reduce(
          (sum, transaction) => sum + transaction.amount,
          0,
        );
        if (positionals.length > 1) console.error(`input: ${input}`);
        console.error(
          `period: ${dateToIso(statement.periodStart)} to ${dateToIso(statement.periodEnd)}`,
        );
        console.error(`transactions: ${statement.transactions.length}`);
        console.error(`opening balance: ${formatMoney(statement.openingBalance)}`);
        console.error(`net movement: ${formatMoney(net)}`);
        console.error(`closing balance: ${formatMoney(statement.closingBalance)}`);
        console.error(`output: ${result.outputPath}`);
      }
    } catch (error) {
      failed = true;
      const message = error instanceof ConversionError ? error.toString() : String(error);
      console.error(positionals.length > 1 ? `${input}: ${message}` : message);
    }
  }
  return failed ? 1 : 0;
}

process.exitCode = await main();
