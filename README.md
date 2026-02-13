# state-audit-poc

Standalone `ts-morph` proof of concept for Recoil/Jotai migration auditing and impact analysis.

## What This Project Does

- Detects migration safety issues with rule-based static analysis (`R001`-`R004`).
- Produces impact reports for a target state (or file): direct readers, runtime writers, init writers, and transitive dependents.
- Supports two analysis profiles:
  - `extended` (default): callbacks, wrappers, one-hop forwarding, and Jotai store API.
  - `core`: direct hooks + dependency extraction only.
- Validates behavior with a fixture suite (`fixtures/`) containing 18 scenarios.

## Requirements

- Node.js
- pnpm

## Install

```bash
pnpm install
```

## Quick Start

```bash
pnpm state:audit --root ./fixtures/C04_R004_stale_recoil_runtime_readonly/src
pnpm state:impact --root ./fixtures/C05_PASS_valid_mixed_migration/src --state counterState --format text
pnpm fixtures:run
pnpm typecheck
```

Real project example:

```bash
ROOT="/path/to/project"
pnpm state:audit --root "$ROOT" --profile extended
pnpm state:impact --root "$ROOT" --profile extended --state pressReleaseBodyJsonState --format json
```

## CLI Reference

### `state:audit`

```bash
pnpm state:audit --root <path>
```

Options:

- `--root <path>` (default: `.`)
- `--tsconfig <path>` (optional)
- `--profile core|extended` (default: `extended`)
- `--format text|json` (default: `text`)
- `--include <glob>` (repeatable or comma-separated)
- `--exclude <glob>` (repeatable or comma-separated)

Exit codes:

- `0`: no violations
- `1`: violations found
- `2`: tool/runtime/config error

### `state:impact`

```bash
pnpm state:impact --root <path> --state <name>
pnpm state:impact --root <path> --file <path>
```

Query modes (exactly one required):

- `--state <name>`
- `--file <path>`

Options:

- `--root <path>` (default: `.`)
- `--tsconfig <path>` (optional)
- `--profile core|extended` (default: `extended`)
- `--include <glob>` (repeatable or comma-separated)
- `--exclude <glob>` (repeatable or comma-separated)
- `--depth <n>` (default: `2`, min: `0`)
- `--format text|json` (default: `text`)

Exit codes:

- `0`: success
- `2`: tool/runtime/config error

### `fixtures:run`

```bash
pnpm fixtures:run
pnpm fixtures:run --format json
pnpm fixtures:run --fixtures ./fixtures
```

Options:

- `--fixtures <path>` (default: `fixtures`)
- `--format text|json` (default: `text`)

Exit codes:

- `0`: all fixtures passed
- `1`: one or more fixtures failed
- `2`: tool/runtime/config error

### `typecheck`

```bash
pnpm typecheck
```

Runs `tsc --noEmit`.

## Configuration Behavior

### Tsconfig Resolution

`tsconfig` selection precedence:

1. `--tsconfig <path>` (explicit)
2. nearest `tsconfig.json` found by walking up from `--root`
3. `./tsconfig.json` from current working directory

If no `tsconfig.json` is found, the project falls back to internal compiler options in `src/core/project.ts`.

### Source File Scope

- Default include globs: `**/*.{ts,tsx}`
- Default exclude globs (always applied):
  - `**/__tests__/**`
  - `**/__storybook__/**`
  - `**/*.test.*`
  - `**/*.spec.*`
  - `**/*.stories.*`

Custom `--exclude` globs are appended to defaults.

## Profiles and Capabilities

| Profile | callbacks | wrappers | forwarding | storeApi |
| --- | --- | --- | --- | --- |
| `extended` (default) | on | on | on | on |
| `core` | off | off | off | off |

Defined in `src/core/profiles.ts`.

## Rules

- `R001` `recoil-selector-reads-jotai`: Recoil `selector`/`selectorFamily` reads Jotai state via `get(...)`.
- `R002` `jotai-derived-reads-recoil`: Jotai derived atom reads Recoil state via `get(...)`.
- `R003` `dead-recoil-state`: exported Recoil `atom`/`selector` has zero non-ignored references.
- `R004` `stale-readonly-recoil-atom`: plain Recoil atom is read at runtime but has no runtime writes.

`R004` excludes init writes from runtime-write validity and reports `initWrites` separately in metrics.

## Fixture Suite

The fixture test harness (`src/cli/run-fixtures.ts`) runs the analyzer against each fixture under `fixtures/` and compares output using semantic subset matching against `expected.json`.

Current fixture matrix:

| Fixture | Expected |
| --- | --- |
| `C01_R001_recoil_selector_reads_jotai` | fail `R001` |
| `C02_R002_jotai_derived_reads_recoil` | fail `R002` |
| `C03_R003_dead_recoil_state` | fail `R003` |
| `C04_R004_stale_recoil_runtime_readonly` | fail `R004` |
| `C05_PASS_valid_mixed_migration` | pass |
| `C06_PASS_recoil_atom_selector_default_exempt` | pass |
| `C07_R003_test_story_refs_ignored` | fail `R003` |
| `C08_PASS_recoil_callback_alias_set_write` | pass |
| `C09_PASS_recoil_callback_reset_write` | pass |
| `C10_R004_init_helper_write_excluded` | fail `R004` |
| `C11_PASS_use_reset_recoil_state_call` | pass |
| `C12_R004_snapshot_get_promise_readonly` | fail `R004` |
| `C13_PASS_wrapper_use_set_recoil_state` | pass |
| `C14_PASS_object_wrapper_state_hook` | pass |
| `C15_PASS_one_hop_prop_forwarding` | pass |
| `C16_PASS_one_hop_function_arg_forwarding` | pass |
| `C17_R001_selector_method_get_reads_jotai` | fail `R001` |
| `C18_R001_selector_store_get_reads_jotai` | fail `R001` |

## Project Layout

```text
state-audit-poc/
  src/
    cli/                       # command entry points
    core/                      # analyzer engine
      events/                  # extraction pipeline (core + extensions)
      rules/                   # R001-R004 evaluators
  fixtures/                    # fixture scenarios + expected outputs
  docs/                        # architecture documentation
  README.md
  POC_TS_MORPH_RECOIL_JOTAI_PRD.md
```

## Development Notes

- Start by adding/updating fixtures for new patterns.
- Run `pnpm fixtures:run` after analyzer changes.
- Run `pnpm typecheck` before committing.

## Additional Docs

- `docs/analyzer-architecture.md` - architecture and pipeline details.
- `POC_TS_MORPH_RECOIL_JOTAI_PRD.md` - original PRD, updated with implementation status.
