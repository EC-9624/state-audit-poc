import type { SourceFile } from "ts-morph";
import type { SymbolIndex } from "../symbols";
import type { AnalyzerConfig, DependencyEdge, UsageEvent } from "../types";
import { dedupeDependencyEdges, dedupeUsageEvents } from "./shared/common";
import type { EventExtractor, EventExtractionResult, EventPipelineContext } from "./types";

// Core
import { coreDirectHooksExtractor, coreDependenciesExtractor, buildDirectSetterBindings, buildSetterBindings } from "./core";

// Extensions
import { callbacksExtractor } from "./extensions/callbacks";
import { propagateSetterBindingsOneHop } from "./extensions/forwarding";
import { buildJotaiStoreSymbolKeys, storeApiExtractor } from "./extensions/store-api";

export { type EventExtractionResult } from "./types";

/* ------------------------------------------------------------------ */
/*  Pipeline                                                          */
/* ------------------------------------------------------------------ */

export function buildUsageEvents(
  sourceFiles: SourceFile[],
  index: SymbolIndex,
  config?: AnalyzerConfig,
): EventExtractionResult {
  const capabilities = config?.capabilities ?? {
    callbacks: true,
    wrappers: true,
    forwarding: true,
    storeApi: true,
  };

  // Phase 1: Build shared bindings
  const jotaiStoreSymbolKeys = capabilities.storeApi
    ? buildJotaiStoreSymbolKeys(sourceFiles, index)
    : new Set<string>();

  const directSetterBindings = capabilities.wrappers
    ? buildSetterBindings(sourceFiles, index)
    : buildDirectSetterBindings(sourceFiles, index);

  const setterBindings = capabilities.forwarding
    ? propagateSetterBindingsOneHop(sourceFiles, directSetterBindings)
    : directSetterBindings;

  // Phase 2: Build pipeline context
  const ctx: EventPipelineContext = {
    sourceFiles,
    index,
    config: config ?? createDefaultConfig(),
    setterBindings,
    jotaiStoreSymbolKeys,
  };

  // Phase 3: Assemble extractors
  const extractors: EventExtractor[] = [
    coreDirectHooksExtractor,
    coreDependenciesExtractor,
  ];

  if (capabilities.callbacks) extractors.push(callbacksExtractor);
  if (capabilities.storeApi) extractors.push(storeApiExtractor);

  // Phase 4: Run all extractors
  const usageEvents: UsageEvent[] = [];
  const dependencyEdges: DependencyEdge[] = [];

  for (const extractor of extractors) {
    const out = extractor.run(ctx);
    usageEvents.push(...out.usageEvents);
    dependencyEdges.push(...out.dependencyEdges);
  }

  return {
    usageEvents: dedupeUsageEvents(usageEvents),
    dependencyEdges: dedupeDependencyEdges(dependencyEdges),
  };
}

function createDefaultConfig(): AnalyzerConfig {
  return {
    rootDir: ".",
    includeGlobs: ["**/*.{ts,tsx}"],
    excludeGlobs: [],
    format: "text",
    profile: "press-release",
    capabilities: {
      callbacks: true,
      wrappers: true,
      forwarding: true,
      storeApi: true,
    },
  };
}
