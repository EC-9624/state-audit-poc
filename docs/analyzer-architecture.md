# Analyzer Architecture (Current State)

This document describes the implemented architecture in `state-audit-poc` as of the current `main` branch.

## Overview

The analyzer is a deterministic static-analysis pipeline for mixed Recoil/Jotai codebases. It does two jobs:

1. `state:audit` - detect migration rule violations (`R001`-`R004`).
2. `state:impact` - report direct readers/writers plus transitive dependents.

The design is intentionally split into focused modules so new extraction logic can be added without rewriting rule logic.

## End-to-End Flow

```text
CLI (state:audit | state:impact)
  -> parse CLI args + build AnalyzerConfig
  -> load ts-morph Project + in-scope source files
  -> build state symbol index
  -> build usage events + dependency edges
  -> (audit) build reference index + evaluate R001-R004
  -> (impact) resolve targets + collect direct/indirect impact
  -> render text/json output
```

Core orchestration entry points:

- `src/core/analyzer.ts` (`createAnalyzerContext`, `runAudit`)
- `src/core/impact.ts` (`runImpact`)
- `src/core/reporter.ts` (text/json rendering)

## Why This Is More Than an AST Walk

A simple syntax walk can find direct hook calls, but this analyzer must also model:

- wrapper hooks that hide setters
- one-hop setter forwarding via function arguments and JSX props
- callback semantics in `useRecoilCallback` and `useAtomCallback`
- dependency edges from selector/derived `get(...)` reads
- runtime vs init write classification for `R004`

Those behaviors drive most complexity in `src/core/events/`.

## Profiles and Capability Flags

Profiles are defined in `src/core/profiles.ts`.

| Profile | Default | callbacks | wrappers | forwarding | storeApi |
| --- | --- | --- | --- | --- | --- |
| `extended` | yes | on | on | on | on |
| `core` | no | off | off | off | off |

Capability flags shape:

```typescript
interface CapabilityFlags {
  callbacks: boolean;
  wrappers: boolean;
  forwarding: boolean;
  storeApi: boolean;
}
```

## Module Layout

```text
src/core/
  config.ts                    # CLI parsing + config + scope filters
  profiles.ts                  # profile and capability flag resolution
  project.ts                   # ts-morph project loading
  symbols.ts                   # state symbol extraction/index
  analyzer.ts                  # audit context + rule orchestration
  impact.ts                    # impact report generation
  reporter.ts                  # text/json renderers
  rules/
    r001-recoil-selector-reads-jotai.ts
    r002-jotai-derived-reads-recoil.ts
    r003-dead-recoil-state.ts
    r004-stale-readonly-recoil-atom.ts
  events/
    pipeline.ts                # phase-based orchestrator
    types.ts                   # EventExtractor + EventPipelineContext
    shared/common.ts           # helpers + constructors + dedupe/sort
    core/
      direct-hooks.ts          # direct read/write extraction
      dependencies.ts          # dependency edge extraction
      setter-bindings.ts       # direct + wrapper-aware binding resolution
    extensions/
      callbacks/index.ts       # callback body extraction
      forwarding/index.ts      # one-hop setter propagation
      store-api/index.ts       # createStore/store.get/store.set extraction
```

## Event Pipeline Internals

Pipeline function: `buildUsageEvents` in `src/core/events/pipeline.ts`.

```text
Phase 1: Build shared bindings
  - [storeApi] buildJotaiStoreSymbolKeys
  - [wrappers] buildSetterBindings vs buildDirectSetterBindings
  - [forwarding] propagateSetterBindingsOneHop

Phase 2: Build EventPipelineContext

Phase 3: Assemble extractors
  - always: coreDirectHooksExtractor, coreDependenciesExtractor
  - [callbacks]: callbacksExtractor
  - [storeApi]: storeApiExtractor

Phase 4: Run extractors and collect outputs

Phase 5: Dedupe + sort outputs for deterministic results
```

Pipeline outputs:

- `usageEvents`: `read`, `runtimeWrite`, `initWrite`
- `dependencyEdges`: `fromStateId -> toStateId` edges

## Rule Evaluation Model

Rules are pure evaluators over `RuleContext` in `src/core/analyzer.ts`.

- `R001`: Recoil selector/selectorFamily reads Jotai state.
- `R002`: Jotai derived atom/atomWithDefault reads Recoil state.
- `R003`: exported Recoil atom/selector has no non-ignored references.
- `R004`: plain Recoil atom has runtime reads but zero runtime writes.

`R004` reports metrics (`runtimeReads`, `runtimeWrites`, `initWrites`) and excludes init writes from runtime-write validity.

## Impact Analysis Model

`runImpact` in `src/core/impact.ts`:

1. Reuses shared analyzer context (symbols/events/dependencies).
2. Resolves targets by `--state` exact name match or `--file` path match.
3. Collects direct readers/writers from `usageEvents`.
4. Computes transitive dependents with BFS on the reverse dependency graph.
5. Returns sorted, deterministic report items.

Depth control (`--depth`) caps BFS traversal.

## Configuration and Scope Behavior

Config behavior is implemented in `src/core/config.ts`.

- include default: `**/*.{ts,tsx}`
- default excludes (always applied):
  - `**/__tests__/**`
  - `**/__storybook__/**`
  - `**/*.test.*`
  - `**/*.spec.*`
  - `**/*.stories.*`
- tsconfig resolution order:
  1. explicit `--tsconfig`
  2. nearest `tsconfig.json` walking up from `--root`
  3. `./tsconfig.json` fallback from current working directory

If no tsconfig is found, `src/core/project.ts` uses internal compiler options.

## Fixture Validation Harness

Fixture runner: `src/cli/run-fixtures.ts`.

For each fixture directory:

1. run audit against `fixtures/<name>/src`
2. load `fixtures/<name>/expected.json`
3. compare with semantic subset matching (expected keys/values must exist in actual)

This keeps fixtures stable while allowing harmless additive fields in analyzer output.

## Determinism Guarantees

Current implementation enforces deterministic output by:

- sorting source files during project load
- deduping and sorting usage events/dependency edges
- sorting rule violations and impact items/sites before rendering

## Current Boundaries

- TS/TSX static analysis only (no runtime execution).
- One-hop forwarding only (no implicit multi-hop propagation).
- Rule set is intentionally scoped to `R001`-`R004`.
- No auto-fix/codemod behavior.

## Extending the Analyzer Safely

Recommended workflow for new patterns:

1. Add or update fixtures first.
2. Implement extraction change in `events/core` or `events/extensions`.
3. Gate optional behavior behind capability flags if needed.
4. Run `pnpm fixtures:run` and `pnpm typecheck`.
5. Update README and this architecture document.
