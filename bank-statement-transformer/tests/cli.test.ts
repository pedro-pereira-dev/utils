import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);

test("npm run transform exposes help", async () => {
  const { stdout } = await execute("npm", ["run", "transform", "--", "--help"]);
  assert.match(stdout, /usage: npm run transform/);
});

test("npm run transform reports invalid invocation with exit code 2", async () => {
  await assert.rejects(execute("npm", ["run", "transform"]), (error: unknown) => {
    return (
      error instanceof Error &&
      "code" in error &&
      error.code === 2 &&
      "stderr" in error &&
      String(error.stderr).includes("At least one input PDF is required")
    );
  });
});

test("npm run transform attempts every input file", async () => {
  await assert.rejects(
    execute("npm", ["run", "transform", "missing-one.pdf", "missing-two.pdf"]),
    (error: unknown) => {
      if (!(error instanceof Error && "stderr" in error)) return false;
      const stderr = String(error.stderr);
      return (
        stderr.includes("missing-one.pdf: UNSUPPORTED_PDF") &&
        stderr.includes("missing-two.pdf: UNSUPPORTED_PDF")
      );
    },
  );
});

test("npm run transform accepts an output directory for multiple files", async () => {
  await assert.rejects(
    execute("npm", ["run", "transform", "one.pdf", "two.pdf", "--output", "output"]),
    (error: unknown) => {
      if (!(error instanceof Error && "stderr" in error)) return false;
      const stderr = String(error.stderr);
      return (
        stderr.includes("one.pdf: UNSUPPORTED_PDF") &&
        stderr.includes("two.pdf: UNSUPPORTED_PDF") &&
        !stderr.includes("output: UNSUPPORTED_PDF")
      );
    },
  );
});
