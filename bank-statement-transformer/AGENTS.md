# Bank Statement Transformer

Node.js 26 and TypeScript CLI for converting supported native-text Portuguese
bank statement PDFs into reconciled CSV files.

- Run with `npm run transform <file.pdf> [more-files.pdf]`.
- Use `--output <directory>` to choose the output directory.
- Output names use `YYYY-MM-statements.csv` and existing files are overwritten.
- Default output is the directory where the command is invoked.
- Process multiple inputs independently; one failure must not stop others.
- Keep monetary calculations in integer cents and require balance reconciliation.
- Do not add bank names, personal information, real statement data, or account identifiers.
- Keep documentation and implementation minimal. Avoid unnecessary abstractions and comments.
- Use `@/` for imports from `src/`.
- Run `npm run format`, `npm run lint`, and `npm test` after changes.
