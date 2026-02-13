# state-audit-poc

Standalone ts-morph proof of concept for Recoil/Jotai migration auditing and impact analysis.

## Commands

```bash
pnpm install
pnpm state:audit --root ./fixtures/C04_R004_stale_recoil_runtime_readonly/src
pnpm state:impact --root ./fixtures/C05_PASS_valid_mixed_migration/src --state counterState --format text
pnpm fixtures:run
```

Real project example:

```bash
ROOT="path-to-project"
pnpm state:audit --root "$ROOT" --profile extended
pnpm state:impact --root "$ROOT" --profile extended --state pressReleaseBodyJsonState --format json
```

## CLI

### `state:audit`

Options:

- `--root <path>`
- `--tsconfig <path>` (optional; if omitted, auto-detects nearest `tsconfig.json` by walking up from `--root`, then falls back to `./tsconfig.json`)
- `--profile core|extended` (default: `extended`)
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
- `--tsconfig <path>` (optional; if omitted, auto-detects nearest `tsconfig.json` by walking up from `--root`, then falls back to `./tsconfig.json`)
- `--profile core|extended` (default: `extended`)
- `--depth <n>`
- `--format text|json`

### Tsconfig Resolution

`tsconfig` selection precedence:

1. `--tsconfig <path>` (explicit)
2. nearest `tsconfig.json` found by walking up from `--root`
3. `./tsconfig.json` from the current working directory

For monorepos, set `--root` to the target app/feature path so auto-detection picks that app's tsconfig.

### Profiles

- `extended`: full capability mode (callbacks, wrappers, forwarding, store API)
- `core`: direct hooks + dependency extraction only

## Rules

- `R001`: recoil-selector-reads-jotai
- `R002`: jotai-derived-reads-recoil
- `R003`: dead-recoil-state
- `R004`: stale-readonly-recoil-atom

`R004` excludes init writes from runtime write validity and reports `initWrites` separately.
