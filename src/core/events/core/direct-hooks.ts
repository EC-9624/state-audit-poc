import { Node, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";
import { resolveCalledFactory, resolveStateFromExpression, type ImportMap, type SymbolIndex } from "../../symbols";
import type { UsageEvent } from "../../types";
import {
  getFallbackSetterKey,
  getSymbolKey,
  JOTAI_READ_FACTORIES,
  RECOIL_READ_FACTORIES,
  createRuntimeReadEvent,
  createWriteEvent,
  getMutationVias,
  isSetterReferenceWriteSite,
  resolveMutationKind,
} from "../shared/common";
import type { EventExtractor, EventPipelineContext } from "../types";
import { resolveStateIdFromIdentifier } from "./setter-bindings";

/* ------------------------------------------------------------------ */
/*  Classifiers                                                       */
/* ------------------------------------------------------------------ */

export function classifyRuntimeRead(
  callExpression: CallExpression,
  importMap: ImportMap,
  index: SymbolIndex,
): UsageEvent | undefined {
  const factory = resolveCalledFactory(callExpression, importMap);
  if (!factory) {
    return undefined;
  }

  const isReadHook =
    (factory.module === "recoil" && RECOIL_READ_FACTORIES.has(factory.imported)) ||
    (factory.module === "jotai" && JOTAI_READ_FACTORIES.has(factory.imported));

  if (!isReadHook) {
    return undefined;
  }

  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) {
    return undefined;
  }

  return createRuntimeReadEvent(callExpression, targetState.id, `${factory.module}:${factory.imported}`);
}

export function classifySetterWriteCall(
  callExpression: CallExpression,
  setterSymbolToStateId: Map<string, string>,
): UsageEvent | undefined {
  const callee = callExpression.getExpression();
  if (!Node.isIdentifier(callee)) {
    return undefined;
  }

  const targetStateId = resolveStateIdFromIdentifier(callee, setterSymbolToStateId);
  if (!targetStateId) {
    return undefined;
  }

  return createWriteEvent(callExpression, targetStateId, "hook-setter-call", "initializeState:hook-setter-call");
}

export function extractSetterReferenceWriteEvents(
  sourceFile: SourceFile,
  setterSymbolToStateId: Map<string, string>,
): UsageEvent[] {
  const events: UsageEvent[] = [];

  for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (!isSetterReferenceWriteSite(identifier)) {
      continue;
    }

    const targetStateId = resolveStateIdFromIdentifier(identifier, setterSymbolToStateId);
    if (!targetStateId) {
      continue;
    }

    events.push(
      createWriteEvent(identifier, targetStateId, "hook-setter-reference", "initializeState:hook-setter-reference"),
    );
  }

  return events;
}

export function classifyDirectMutationWrite(
  callExpression: CallExpression,
  jotaiStoreSymbolKeys: Set<string>,
  index: SymbolIndex,
): UsageEvent | undefined {
  if (isJotaiStoreSetCall(callExpression, jotaiStoreSymbolKeys)) {
    return undefined;
  }

  const mutationKind = resolveMutationKind(callExpression.getExpression());
  if (!mutationKind) {
    return undefined;
  }

  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) {
    return undefined;
  }

  const [runtimeVia, initVia] = getMutationVias(mutationKind);
  return createWriteEvent(callExpression, targetState.id, runtimeVia, initVia);
}

/* ------------------------------------------------------------------ */
/*  Jotai store.set guard (used by classifyDirectMutationWrite)       */
/* ------------------------------------------------------------------ */

function isJotaiStoreSetCall(callExpression: CallExpression, jotaiStoreSymbolKeys: Set<string>): boolean {
  const callee = callExpression.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "set") {
    return false;
  }

  const base = callee.getExpression();
  if (!Node.isIdentifier(base)) {
    return false;
  }

  return isKnownJotaiStoreIdentifier(base, jotaiStoreSymbolKeys);
}

function isKnownJotaiStoreIdentifier(identifier: Node, jotaiStoreSymbolKeys: Set<string>): boolean {
  if (!Node.isIdentifier(identifier)) {
    return false;
  }

  const symbolKey = getSymbolKey(identifier);
  if (symbolKey && jotaiStoreSymbolKeys.has(`sym|${symbolKey}`)) {
    return true;
  }

  return jotaiStoreSymbolKeys.has(
    getFallbackSetterKey(identifier.getSourceFile().getFilePath(), identifier.getText()),
  );
}

/* ------------------------------------------------------------------ */
/*  Extractor                                                         */
/* ------------------------------------------------------------------ */

export const coreDirectHooksExtractor: EventExtractor = {
  id: "core:direct-hooks",
  run(ctx: EventPipelineContext) {
    const usageEvents: UsageEvent[] = [];
    const pushIfDefined = <T>(items: T[], item: T | undefined) => { if (item) items.push(item); };

    for (const sourceFile of ctx.sourceFiles) {
      const importMap = ctx.index.importMapByFilePath.get(sourceFile.getFilePath());
      for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        pushIfDefined(usageEvents, importMap ? classifyRuntimeRead(callExpression, importMap, ctx.index) : undefined);
        pushIfDefined(usageEvents, classifySetterWriteCall(callExpression, ctx.setterBindings));
        pushIfDefined(usageEvents, classifyDirectMutationWrite(callExpression, ctx.jotaiStoreSymbolKeys, ctx.index));
      }
      usageEvents.push(...extractSetterReferenceWriteEvents(sourceFile, ctx.setterBindings));
    }
    return { usageEvents, dependencyEdges: [] };
  },
};
