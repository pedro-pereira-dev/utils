# Repository Context

This repository contains small, independent utilities. Keep each tool simple,
self-contained, and easy to maintain.

Read each tool's local `AGENTS.md` before changing it:

- [`bank-statement-transformer/AGENTS.md`](bank-statement-transformer/AGENTS.md)

## Git Hooks

The root `.githooks/pre-commit` dispatches to executable hooks under each changed
tool's `.githooks/pre-commit`. New tools should own their checks in the same way;
do not hardcode tool-specific commands in the root hook.
