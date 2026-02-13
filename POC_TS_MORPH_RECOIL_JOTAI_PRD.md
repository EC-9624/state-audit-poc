# PRD: Standalone POC for Recoil/Jotai Migration Analyzer (ts-morph)

Status: Implemented (v0.1.0 POC snapshot)

Owner: State Migration Working Group

## 0) Current Implementation Snapshot

This PRD started as a build spec and now also tracks implemented state.

Current snapshot:

- Rule engine implemented for `R001`-`R004`.
- Impact analysis implemented for `--state` and `--file` query modes.
- Profile system implemented (`core`, `extended`) with capability flags.
- Fixture harness implemented with semantic subset matching (`C01`-`C18`).
- CLI commands available: `state:audit`, `state:impact`, `fixtures:run`, `typecheck`.

## 1) Purpose

Build a standalone proof of concept (POC) that validates whether `ts-morph` can:

1. Detect Recoil/Jotai usage accurately.
2. Detect known migration mistake patterns via explicit rules.
3. Produce scope-of-impact reports for developer decision-making.

This POC must be repository-agnostic and runnable on synthetic fixtures.

## 2) Background

During phased migration from Recoil to Jotai, mixed state systems are common. Regressions often occur when migration is partial:

- State definition is migrated but some old readers remain.
- Runtime setters are migrated but old Recoil readers still consume stale state.
- Cross-store dependencies are introduced (`Recoil selector -> Jotai`, or reverse).
- Manual graph inspection is not deterministic enough for prevention.

## 3) Problem Statement

We need deterministic static analysis to prevent known migration bugs and to answer:

"If I touch this state, which functions/files are affected?"

## 4) Goals

- Prove rule-based detection logic with `ts-morph`.
- Prove impact analysis for read/write/dependency scope.
- Produce machine-readable and human-readable outputs.
- Keep implementation independent from any specific production repository.

## 5) Non-goals

- CI integration into a real repository.
- Auto-fix/codemod support.
- Full language/framework coverage beyond TS/TSX + Recoil/Jotai patterns.

## 6) Success Criteria

POC is successful when all are true:

1. Rule fixtures fail/pass exactly as expected.
2. Impact output lists direct readers/writers and transitive dependents.
3. The stale runtime bug pattern is caught deterministically.
4. Output schema is stable enough to wire into CI later.

## 7) Scope

Input scope for POC:

- Any local folder containing TS/TSX fixtures.

Default ignore patterns:

- `**/__tests__/**`
- `**/__storybook__/**`
- `**/*.test.*`
- `**/*.spec.*`
- `**/*.stories.*`

## 8) Functional Requirements

## 8.1 Audit Rules (`state:audit`)

### R001: recoil-selector-reads-jotai

Fail if Recoil `selector`/`selectorFamily` reads Jotai atom/family through `get(...)`.

### R002: jotai-derived-reads-recoil

Fail if Jotai derived atom (`atom(read)` / `atomWithDefault`) reads Recoil atom/selector/family through `get(...)`.

### R003: dead-recoil-state

Fail if exported Recoil atom/selector has zero non-ignored references.

### R004: stale-readonly-recoil-atom

Fail if plain Recoil `atom` (non-selector default) has:

- runtime reads > 0
- runtime writes = 0

Critical semantics for R004:

- Init writes (`initializeState`/snapshot setup) are excluded from runtime write validity.
- Init writes should still be reported as `initWrites` metric.

## 8.2 Impact Analysis (`state:impact`)

Given a state (or file), return:

- definition location
- direct readers
- runtime writers
- init writers
- transitive dependents (configurable depth)

## 9) Non-functional Requirements

- Deterministic output for same input.
- Reasonable performance on fixture sets.
- Stable JSON schema.
- Zero dependency on target monorepo internals.

## 10) Technical Approach

Use `ts-morph` for project loading, symbol resolution, and cross-file reference scanning.

Analyzer pipeline:

1. Load TypeScript project from POC `tsconfig`.
2. Build state symbol index:
   - Recoil: `atom`, `selector`, `atomFamily`, `selectorFamily`
   - Jotai: `atom`, `atomFamily`, `atomWithDefault`, derived atoms
3. Build usage events:
   - `read`
   - `runtimeWrite`
   - `initWrite`
4. Resolve cross-store `get(...)` edges.
5. Evaluate rules R001-R004.
6. Emit text + JSON reports.

## 11) CLI Contract

## 11.1 `state:audit`

Command:

```bash
pnpm state:audit --root ./fixtures/C04_R004_stale_recoil_runtime_readonly/src
```

Options:

- `--root <path>`
- `--tsconfig <path>` (optional; auto-detects nearest `tsconfig.json` from `--root` when omitted)
- `--profile core|extended` (default: `extended`)
- `--format text|json` (default: `text`)
- `--include <glob>` (optional)
- `--exclude <glob>` (optional)

Exit codes:

- `0`: no violations
- `1`: violations found
- `2`: tool/runtime/config error

## 11.2 `state:impact`

Command:

```bash
pnpm state:impact --root ./fixtures/C05_PASS_valid_mixed_migration/src --state counterState
```

Query modes (exactly one):

- `--state <name>`
- `--file <path>`

Options:

- `--root <path>`
- `--tsconfig <path>` (optional; auto-detects nearest `tsconfig.json` from `--root` when omitted)
- `--profile core|extended` (default: `extended`)
- `--include <glob>` (optional)
- `--exclude <glob>` (optional)
- `--depth <n>`
- `--format text|json`

Exit codes:

- `0`: success
- `2`: tool/runtime/config error

## 12) Implemented POC Project Structure

```text
state-audit-poc/
  package.json
  tsconfig.json
  README.md
  POC_TS_MORPH_RECOIL_JOTAI_PRD.md
  docs/
    analyzer-architecture.md
  src/
    cli/
      state-audit.ts
      state-impact.ts
      run-fixtures.ts
    core/
      analyzer.ts
      config.ts
      events.ts
      impact.ts
      profiles.ts
      project.ts
      reporter.ts
      symbols.ts
      types.ts
      events/
        pipeline.ts
        types.ts
        shared/common.ts
        core/
          direct-hooks.ts
          dependencies.ts
          setter-bindings.ts
        extensions/
          callbacks/index.ts
          forwarding/index.ts
          store-api/index.ts
      rules/
        r001-recoil-selector-reads-jotai.ts
        r002-jotai-derived-reads-recoil.ts
        r003-dead-recoil-state.ts
        r004-stale-readonly-recoil-atom.ts
  fixtures/
    C01_R001_recoil_selector_reads_jotai/
    C02_R002_jotai_derived_reads_recoil/
    C03_R003_dead_recoil_state/
    C04_R004_stale_recoil_runtime_readonly/
    C05_PASS_valid_mixed_migration/
    C06_PASS_recoil_atom_selector_default_exempt/
    C07_R003_test_story_refs_ignored/
    C08_PASS_recoil_callback_alias_set_write/
    C09_PASS_recoil_callback_reset_write/
    C10_R004_init_helper_write_excluded/
    C11_PASS_use_reset_recoil_state_call/
    C12_R004_snapshot_get_promise_readonly/
    C13_PASS_wrapper_use_set_recoil_state/
    C14_PASS_object_wrapper_state_hook/
    C15_PASS_one_hop_prop_forwarding/
    C16_PASS_one_hop_function_arg_forwarding/
    C17_R001_selector_method_get_reads_jotai/
    C18_R001_selector_store_get_reads_jotai/
```

## 13) Fixture Expectations

- C01 -> `R001` fail
- C02 -> `R002` fail
- C03 -> `R003` fail
- C04 -> `R004` fail (`runtimeWrites=0`, `initWrites>0`)
- C05 -> pass
- C06 -> pass (selector-default exemption from R004)
- C07 -> `R003` fail (test/story references ignored)
- C08 -> pass (callback alias set write recognized)
- C09 -> pass (callback reset write recognized)
- C10 -> `R004` fail (init-only helper writes do not count as runtime writes)
- C11 -> pass (`useResetRecoilState` write recognized)
- C12 -> `R004` fail (`snapshot.getPromise` read without runtime write)
- C13 -> pass (wrapper hook around `useSetRecoilState` recognized)
- C14 -> pass (object-returning wrapper state hook recognized)
- C15 -> pass (one-hop prop forwarding recognized)
- C16 -> pass (one-hop function-argument forwarding recognized)
- C17 -> `R001` fail (selector method-form `get` reads Jotai)
- C18 -> `R001` fail (selector `store.get` reads Jotai)

## 14) Output Schema (JSON)

```json
{
  "ok": false,
  "summary": {
    "violations": 1
  },
  "violations": [
    {
      "rule": "R004",
      "state": "legacyCounterState",
      "file": "fixtures/C04_R004_stale_recoil_runtime_readonly/src/state.ts",
      "line": 5,
      "message": "Recoil atom is read at runtime but has no runtime writes",
      "metrics": {
        "runtimeReads": 2,
        "runtimeWrites": 0,
        "initWrites": 1
      }
    }
  ]
}
```

## 15) Milestones

- [x] Implement symbol extraction.
- [x] Implement usage event classification.
- [x] Implement `R001`-`R004`.
- [x] Implement fixture runner and expected-result validator.
- [x] Implement impact command.
- [x] Document architecture and usage (`README.md`, `docs/analyzer-architecture.md`).

## 16) Risks and Mitigations

Risk: false positives from aliasing/wrapper patterns.

Mitigation:

- start with direct patterns
- add fixture per discovered edge case

Risk: slow reference scanning.

Mitigation:

- keep POC scope small
- cache symbol lookups

## 17) Deliverables

- Standalone runnable POC project (`state:audit`, `state:impact`, `fixtures:run`).
- Fixture matrix with expected outputs (`C01`-`C18`).
- Architecture and usage documentation:
  - `README.md`
  - `docs/analyzer-architecture.md`
  - this PRD (status-tracking snapshot)

## 18) Historical AI Agent Handoff Prompt

Use this exact task prompt for implementation agents:

"Implement a standalone ts-morph POC for Recoil/Jotai migration safety.
Support rules R001-R004 and a state impact report.
Use fixture-driven validation, repository-agnostic paths, and deterministic text/json outputs.
Ensure R004 excludes init writes from runtime write validity and reports initWrites separately."
