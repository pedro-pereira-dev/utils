# Bank Statement Transformer

Converts supported native-text Portuguese bank statement PDFs to CSV. Every
transaction is reconciled against the running balance before output is written.

## Use

Requires Node.js 26.

```bash
npm install
npm run transform statement.pdf
npm run transform january.pdf february.pdf
```

The output defaults to `YYYY-MM-statements.csv` in the current directory.
Use `--output DIRECTORY` to write the generated files elsewhere.

```text
npm run transform [--output PATH] [--verbose] INPUT.pdf [...]
```

## Test

```bash
npm test
```
