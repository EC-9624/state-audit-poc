import { Node, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";
import { resolveCalledFactory, resolveStateFromExpression, type SymbolIndex } from "../../../symbols";
import type { UsageEvent } from "../../../types";
import { createWriteEvent, getFallbackSetterKey, getSymbolKey } from "../../shared/common";
import type { EventExtractor, EventPipelineContext } from "../../types";

/* ------------------------------------------------------------------ */
/*  Jotai store symbol detection                                      */
/* ------------------------------------------------------------------ */

export function buildJotaiStoreSymbolKeys(sourceFiles: SourceFile[], index: SymbolIndex): Set<string> {
  const keys = new Set<string>();

  for (const sourceFile of sourceFiles) {
    const importMap = index.importMapByFilePath.get(sourceFile.getFilePath());
    if (!importMap) continue;

    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const initCall = declaration.getInitializerIfKind(SyntaxKind.CallExpression);
      if (!initCall) continue;

      const factory = resolveCalledFactory(initCall, importMap);
      if (!factory || factory.module !== "jotai" || factory.imported !== "createStore") continue;

      const nameNode = declaration.getNameNode();
      if (!Node.isIdentifier(nameNode)) continue;

      const symbolKey = getSymbolKey(nameNode);
      if (symbolKey) keys.add(`sym|${symbolKey}`);
      keys.add(getFallbackSetterKey(sourceFile.getFilePath(), nameNode.getText()));
    }
  }

  return keys;
}

/* ------------------------------------------------------------------ */
/*  Jotai store.set write classification                              */
/* ------------------------------------------------------------------ */

export function classifyJotaiStoreSetWrite(
  callExpression: CallExpression,
  jotaiStoreSymbolKeys: Set<string>,
  index: SymbolIndex,
): UsageEvent | undefined {
  if (!isJotaiStoreSetCall(callExpression, jotaiStoreSymbolKeys)) return undefined;
  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) return undefined;
  return createWriteEvent(callExpression, targetState.id, "jotai:store.set", "initializeState:jotai:store.set");
}

/* ------------------------------------------------------------------ */
/*  Jotai store.get / store.set detection                             */
/* ------------------------------------------------------------------ */

export function isJotaiStoreGetCall(callExpression: CallExpression, jotaiStoreSymbolKeys: Set<string>): boolean {
  const callee = callExpression.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "get") return false;
  const base = callee.getExpression();
  if (!Node.isIdentifier(base)) return false;
  return isKnownJotaiStoreIdentifier(base, jotaiStoreSymbolKeys);
}

function isJotaiStoreSetCall(callExpression: CallExpression, jotaiStoreSymbolKeys: Set<string>): boolean {
  const callee = callExpression.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "set") return false;
  const base = callee.getExpression();
  if (!Node.isIdentifier(base)) return false;
  return isKnownJotaiStoreIdentifier(base, jotaiStoreSymbolKeys);
}

function isKnownJotaiStoreIdentifier(identifier: Node, jotaiStoreSymbolKeys: Set<string>): boolean {
  if (!Node.isIdentifier(identifier)) return false;
  const symbolKey = getSymbolKey(identifier);
  if (symbolKey && jotaiStoreSymbolKeys.has(`sym|${symbolKey}`)) return true;
  return jotaiStoreSymbolKeys.has(getFallbackSetterKey(identifier.getSourceFile().getFilePath(), identifier.getText()));
}

/* ------------------------------------------------------------------ */
/*  Extractor                                                         */
/* ------------------------------------------------------------------ */

export const storeApiExtractor: EventExtractor = {
  id: "ext:store-api",
  run(ctx: EventPipelineContext) {
    const usageEvents: UsageEvent[] = [];
    for (const sourceFile of ctx.sourceFiles) {
      for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const event = classifyJotaiStoreSetWrite(callExpression, ctx.jotaiStoreSymbolKeys, ctx.index);
        if (event) usageEvents.push(event);
      }
    }
    return { usageEvents, dependencyEdges: [] };
  },
};
