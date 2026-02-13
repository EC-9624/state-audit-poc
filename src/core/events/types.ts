import type { SourceFile } from "ts-morph";
import type { SymbolIndex } from "../symbols";
import type { AnalyzerConfig, DependencyEdge, UsageEvent } from "../types";

export interface EventPipelineContext {
  sourceFiles: SourceFile[];
  index: SymbolIndex;
  config: AnalyzerConfig;
  setterBindings: Map<string, string>;
  jotaiStoreSymbolKeys: Set<string>;
}

export interface EventExtractionResult {
  usageEvents: UsageEvent[];
  dependencyEdges: DependencyEdge[];
}

export interface EventExtractor {
  id: string;
  run(ctx: EventPipelineContext): EventExtractionResult;
}
