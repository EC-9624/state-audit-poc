# Analyzer Architecture and Pattern Inventory

This document explains why the analyzer is larger than a simple `ts-morph` AST walk, how the code is structured now, and what Recoil/Jotai read-write patterns appear in `press-release-editor-v3`.

## Why This Is Not a "Simple Walk"

At a high level, a simple walk can only answer:

- "Find calls to `useRecoilValue(...)`"
- "Find definitions of `atom(...)`"

This analyzer must answer harder questions:

1. **Wrapper resolution**
   - Detect writes through custom hooks (for example, `useSetXxxState()` that wraps `useSetRecoilState(...)`).
2. **Forwarding resolution (one hop)**
   - Detect when setter functions are passed as function args or JSX props and called in the callee.
3. **Callback semantics**
   - Detect reads/writes inside `useRecoilCallback` and `useAtomCallback`.
4. **Dependency graph extraction**
   - Build state-to-state edges from selector/derived `get(...)` reads (including method syntax and atom defaults).
5. **Runtime vs init write classification**
   - Separate `runtimeWrite` and `initWrite` for R004 correctness.

Those capabilities are what add code volume.

## Profiles

The analyzer supports two profiles that control which capabilities are enabled:

| Profile          | CLI default? | Capabilities enabled                       |
|------------------|-------------|---------------------------------------------|
| `press-release`  | Yes         | All (callbacks, wrappers, forwarding, storeApi) |
| `core`           | No          | None — direct hooks and dependencies only   |

Defined in `src/core/profiles.ts`. The `press-release` profile is the default to preserve backward compatibility and full accuracy. The `core` profile provides a simpler, faster analysis that only detects direct Recoil/Jotai hook calls and selector dependency edges.

**Profile impact on real codebase** (`press-release-editor-v3`):
- `press-release`: 29 violations (1 R001, 1 R003, 27 R004)
- `core`: 38 violations (0 R001, 1 R003, 37 R004) — 9 extra R004 false positives because wrapper/callback/forwarding detection is disabled

### Capability Flags

```typescript
interface CapabilityFlags {
  callbacks: boolean;   // useRecoilCallback / useAtomCallback extraction
  wrappers: boolean;    // alias-aware wrapper hook resolution
  forwarding: boolean;  // one-hop setter propagation via args/props
  storeApi: boolean;    // Jotai createStore / store.get / store.set
}
```

## Module Layout (Core + Extensions)

The `events` logic is organized into three layers:

```
src/core/events/
├── types.ts                          # EventExtractor interface, EventPipelineContext
├── pipeline.ts                       # Registry-based orchestrator with capability gates
├── shared/
│   └── common.ts                     # Shared helpers, constants, event constructors, dedupe/sort
├── core/                             # Always-on extractors (no capability gate)
│   ├── index.ts                      # Barrel export
│   ├── direct-hooks.ts               # Runtime read/write classifiers for direct hook calls
│   ├── dependencies.ts               # Selector/derived get(...) dependency edge extraction
│   └── setter-bindings.ts            # Direct + wrapper-aware setter binding resolution
└── extensions/                       # Gated by CapabilityFlags
    ├── callbacks/
    │   └── index.ts                  # useRecoilCallback + useAtomCallback extraction
    ├── forwarding/
    │   └── index.ts                  # One-hop arg/prop setter propagation
    └── store-api/
        └── index.ts                  # Jotai createStore / store.get / store.set
```

Supporting modules outside `events/`:

- `src/core/profiles.ts` — profile definitions + capability flag resolution
- `src/core/config.ts` — accepts `profile` CLI input, wires `AnalyzerProfile` + `CapabilityFlags`
- `src/core/events.ts` — thin re-export of `buildUsageEvents` (public entry point, unchanged)

### Core Extractors (always active)

| Module | Extractor ID | What it does |
|--------|-------------|--------------|
| `core/direct-hooks.ts` | `core:direct-hooks` | Classifies `useRecoilValue`, `useSetRecoilState`, `useAtomValue`, `useSetAtom`, etc. as read/runtimeWrite/initWrite events |
| `core/dependencies.ts` | `core:dependencies` | Extracts state-to-state dependency edges from selector `get(...)`, derived atoms, and atom default selectors |
| `core/setter-bindings.ts` | (utility, not an extractor) | Builds `Map<localVar, symbolKey>` for setter resolution; exports both `buildDirectSetterBindings` (core) and `buildSetterBindings` (wrapper-aware) |

### Extension Extractors (gated by capabilities)

| Module | Extractor ID | Capability gate | What it does |
|--------|-------------|----------------|--------------|
| `extensions/callbacks/` | `ext:callbacks` | `callbacks` | Extracts read/write events from `useRecoilCallback` and `useAtomCallback` bodies |
| `extensions/store-api/` | `ext:store-api` | `storeApi` | Detects `store.get(...)` / `store.set(...)` from Jotai `createStore()` |
| `extensions/forwarding/` | (utility, not an extractor) | `forwarding` | Runs `propagateSetterBindingsOneHop` to extend setter bindings through function args and JSX props |

Note: `wrappers` and `forwarding` are not standalone `EventExtractor` implementations. They are toggles in the pipeline's binding-build phase:
- **wrappers**: `buildSetterBindings` (wrapper-aware) vs `buildDirectSetterBindings` (direct only)
- **forwarding**: `propagateSetterBindingsOneHop` applied after binding resolution

## Event Pipeline (Data Flow)

```
buildUsageEvents(sourceFiles, index, config)
│
├─ Phase 1: Build shared bindings
│   ├─ [storeApi?]  buildJotaiStoreSymbolKeys()
│   ├─ [wrappers?]  buildSetterBindings() vs buildDirectSetterBindings()
│   └─ [forwarding?] propagateSetterBindingsOneHop()
│
├─ Phase 2: Build pipeline context (EventPipelineContext)
│
├─ Phase 3: Assemble extractors
│   ├─ always:      coreDirectHooksExtractor, coreDependenciesExtractor
│   ├─ [callbacks?] callbacksExtractor
│   └─ [storeApi?]  storeApiExtractor
│
├─ Phase 4: Run all extractors → collect usageEvents + dependencyEdges
│
└─ Phase 5: Dedupe + sort → return EventExtractionResult
```

Outputs:

- `usageEvents` — read/runtimeWrite/initWrite events (consumed by rules R001-R004)
- `dependencyEdges` — state-to-state edges (consumed by `state:impact` transitive traversal)

## Why LOC Is Concentrated in `events/*`

`events/*` is effectively a mini static-analysis engine:

- it models control/data flow patterns, not just syntax
- it normalizes multiple API forms into one internal event model
- it supports both Recoil and Jotai while migration is mixed

This is why complexity is high even though the tool is still a POC.

## Recoil/Jotai Pattern Inventory: `press-release-editor-v3`

Source analyzed:

- root: `/Users/eakudompong.chanoknan/prtimes-dev-docker/prtimes-frontend/src/apps/prtimes/src/features/press-release-editor-v3`
- scope for counts below: `*.ts` + `*.tsx`
- "production_scope" here excludes `*.test.*`, `*.spec.*`, `*.stories.*`
- `*.test-setup.*` is intentionally kept in scope for now

## Distinct pattern families observed (production_scope)

- Recoil read patterns: **6**
- Recoil write patterns: **5**
- Jotai read patterns: **5**
- Jotai write patterns: **4**
- Wrapper-heavy usage patterns: **2**

## Pattern counts (production_scope)

Recoil read-side indicators:

- `useRecoilValue(...)`: **162**
- `useRecoilState(...)` (read+write hook): **24**
- selector `get({get}) { ... }` method form: **26**
- selector `get: ({get}) => ...` arrow form: **1**
- `snapshot.getPromise(...)`: **14**
- `useRecoilCallback(...)` callsites: **31**

Recoil write-side indicators:

- `useSetRecoilState(...)`: **46**
- `useRecoilState(...)` (setter side implied): **24**
- `useResetRecoilState(...)`: **2**
- `initializeState=` usage: **4**
- callback mutation context via `useRecoilCallback(...)`: **31** (same callsite count as above)

Jotai read-side indicators:

- `useAtomValue(...)`: **102**
- `useAtom(...)` (read+write hook): **15**
- derived `atom((get) => ...)` form: **7**
- `useAtomCallback(...)` (read/write callback context): **5**
- direct `store.get(...)`: **1**

Jotai write-side indicators:

- `useSetAtom(...)`: **11**
- `useAtom(...)` (setter side implied): **15**
- `useAtomCallback(...)` (set path): **5**
- direct `store.set(...)`: **0** in production scope (appears in tests)

Wrapper patterns that drive complexity:

- exported `useSet*` wrapper hooks: **50**
- tuple usage from custom state hooks (`const [_, setX] = useXState()`): **52**

## Interpretation

This feature is wrapper-heavy and callback-heavy. That is why the analyzer needs:

- alias-aware wrapper resolution
- one-hop propagation
- callback-aware read/write extraction
- dependency extraction that handles selector method and atom default-selector forms

Without those, impact and R004 become noisy or incomplete — as demonstrated by the 9 extra false-positive R004 violations in `core` profile vs `press-release` profile.

## Practical Maintenance Notes

To keep this maintainable while preserving capability:

1. Keep logic split by concern: core extractors in `events/core/`, extensions in `events/extensions/`.
2. Add fixtures first for every new pattern before changing logic.
3. Treat `common.ts` event constructors as the single source for event shape.
4. New extensions should implement the `EventExtractor` interface and be gated by a capability flag in the pipeline.
5. Keep one-hop propagation boundary explicit (no silent multi-hop expansion).
6. When adding a new profile, add an entry in `profiles.ts` FLAGS and verify fixture compatibility.
