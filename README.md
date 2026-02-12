# state-audit-poc

Standalone ts-morph proof of concept for Recoil/Jotai migration auditing and impact analysis.

## Commands

```bash
pnpm install
pnpm state:audit --root ./fixtures/C04_R004_stale_recoil_runtime_readonly/src
pnpm state:impact --root ./fixtures/C05_PASS_valid_mixed_migration/src --state counterState --format text
pnpm fixtures:run
```

## CLI

### `state:audit`

Options:

- `--root <path>`
- `--tsconfig <path>`
- `--format text|json` (default: `text`)
- `--include <glob>` (repeatable or comma-separated)
- `--exclude <glob>` (repeatable or comma-separated)

Exit codes:

- `0`: no violations
- `1`: violations found
- `2`: tool/runtime/config error

### `state:impact`

Query modes (exactly one):

- `--state <name>`
- `--file <path>`

Options:

- `--root <path>`
- `--tsconfig <path>`
- `--depth <n>`
- `--format text|json`

## Rules

- `R001`: recoil-selector-reads-jotai
- `R002`: jotai-derived-reads-recoil
- `R003`: dead-recoil-state
- `R004`: stale-readonly-recoil-atom

`R004` excludes init writes from runtime write validity and reports `initWrites` separately.
