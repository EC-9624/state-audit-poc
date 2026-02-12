import { SyntaxKind, type SourceFile } from "ts-morph";
import type { SymbolIndex } from "../symbols";
import type { DependencyEdge, UsageEvent } from "../types";
import { extractJotaiAtomCallbackEvents, extractRecoilCallbackEvents } from "./callbacks";
import {
  classifyDirectMutationWrite,
  classifyJotaiStoreSetWrite,
  classifyRuntimeRead,
  classifySetterWriteCall,
  extractSetterReferenceWriteEvents,
} from "./classifiers";
import { dedupeDependencyEdges, dedupeUsageEvents, pushIfDefined } from "./common";
import { buildDependencyEvents } from "./dependencies";
import { buildJotaiStoreSymbolKeys, buildSetterBindings, propagateSetterBindingsOneHop } from "./setter-bindings";

export interface EventExtractionResult {
  usageEvents: UsageEvent[];
  dependencyEdges: DependencyEdge[];
}

export function buildUsageEvents(sourceFiles: SourceFile[], index: SymbolIndex): EventExtractionResult {
  const usageEvents: UsageEvent[] = [];
  const dependencyEdges: DependencyEdge[] = [];

  const jotaiStoreSymbolKeys = buildJotaiStoreSymbolKeys(sourceFiles, index);
  const directSetterSymbolToStateId = buildSetterBindings(sourceFiles, index);
  const setterSymbolToStateId = propagateSetterBindingsOneHop(sourceFiles, directSetterSymbolToStateId);

  for (const sourceFile of sourceFiles) {
    const importMap = index.importMapByFilePath.get(sourceFile.getFilePath());

    for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      pushIfDefined(usageEvents, importMap ? classifyRuntimeRead(callExpression, importMap, index) : undefined);
      pushIfDefined(usageEvents, classifySetterWriteCall(callExpression, setterSymbolToStateId));
      pushIfDefined(usageEvents, classifyJotaiStoreSetWrite(callExpression, jotaiStoreSymbolKeys, index));
      pushIfDefined(usageEvents, classifyDirectMutationWrite(callExpression, jotaiStoreSymbolKeys, index));
    }

    if (importMap) {
      usageEvents.push(...extractRecoilCallbackEvents(sourceFile, importMap, index));
      usageEvents.push(...extractJotaiAtomCallbackEvents(sourceFile, importMap, index));
    }

    usageEvents.push(...extractSetterReferenceWriteEvents(sourceFile, setterSymbolToStateId));
  }

  const dependencyEvents = buildDependencyEvents(index, jotaiStoreSymbolKeys);
  usageEvents.push(...dependencyEvents.usageEvents);
  dependencyEdges.push(...dependencyEvents.dependencyEdges);

  return {
    usageEvents: dedupeUsageEvents(usageEvents),
    dependencyEdges: dedupeDependencyEdges(dependencyEdges),
  };
}
