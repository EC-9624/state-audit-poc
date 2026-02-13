import { Node, SyntaxKind, type CallExpression, type Expression, type SourceFile } from "ts-morph";
import { resolveCalledFactory, resolveStateFromExpression, type ImportMap, type SymbolIndex } from "../../../symbols";
import type { UsageEvent } from "../../../types";
import {
  collectIdentifiersFromBindingName,
  createRuntimeReadEvent,
  createWriteEvent,
  getMutationVias,
  RECOIL_SNAPSHOT_READ_METHODS,
  type CallbackFactoryFunction,
  type JotaiAtomCallbackBindings,
  type RecoilCallbackBindings,
} from "../../shared/common";
import type { EventExtractor, EventPipelineContext } from "../../types";

/* ------------------------------------------------------------------ */
/*  Extractor                                                         */
/* ------------------------------------------------------------------ */

export const callbacksExtractor: EventExtractor = {
  id: "ext:callbacks",
  run(ctx: EventPipelineContext) {
    const usageEvents: UsageEvent[] = [];
    for (const sourceFile of ctx.sourceFiles) {
      const importMap = ctx.index.importMapByFilePath.get(sourceFile.getFilePath());
      if (!importMap) continue;
      usageEvents.push(...extractRecoilCallbackEvents(sourceFile, importMap, ctx.index));
      usageEvents.push(...extractJotaiAtomCallbackEvents(sourceFile, importMap, ctx.index));
    }
    return { usageEvents, dependencyEdges: [] };
  },
};

/* ------------------------------------------------------------------ */
/*  Recoil callbacks                                                  */
/* ------------------------------------------------------------------ */

function extractRecoilCallbackEvents(sourceFile: SourceFile, importMap: ImportMap, index: SymbolIndex): UsageEvent[] {
  return extractCallbackEvents(sourceFile, importMap, "recoil", "useRecoilCallback", parseRecoilCallbackBindings, classifyRecoilCallbackRead, classifyRecoilCallbackWrite, index);
}

function extractJotaiAtomCallbackEvents(sourceFile: SourceFile, importMap: ImportMap, index: SymbolIndex): UsageEvent[] {
  return extractCallbackEvents(sourceFile, importMap, "jotai/utils", "useAtomCallback", parseJotaiAtomCallbackBindings, classifyJotaiAtomCallbackRead, classifyJotaiAtomCallbackWrite, index);
}

function extractCallbackEvents<TBindings>(
  sourceFile: SourceFile,
  importMap: ImportMap,
  hookModule: string,
  hookImported: string,
  parseBindings: (f: CallbackFactoryFunction) => TBindings,
  classifyRead: (c: CallExpression, b: TBindings, i: SymbolIndex) => UsageEvent | undefined,
  classifyWrite: (c: CallExpression, b: TBindings, i: SymbolIndex) => UsageEvent | undefined,
  index: SymbolIndex,
): UsageEvent[] {
  const events: UsageEvent[] = [];

  for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const factory = resolveCalledFactory(callExpression, importMap);
    if (!factory || factory.module !== hookModule || factory.imported !== hookImported) continue;

    const callbackFactory = resolveCallbackFactoryFunction(callExpression.getArguments()[0], importMap);
    if (!callbackFactory) continue;

    const bindings = parseBindings(callbackFactory);
    for (const innerCall of callbackFactory.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const readEvent = classifyRead(innerCall, bindings, index);
      if (readEvent) events.push(readEvent);
      const writeEvent = classifyWrite(innerCall, bindings, index);
      if (writeEvent) events.push(writeEvent);
    }
  }

  return events;
}

/* ------------------------------------------------------------------ */
/*  Binding parsers                                                   */
/* ------------------------------------------------------------------ */

function parseRecoilCallbackBindings(callbackFactory: CallbackFactoryFunction): RecoilCallbackBindings {
  const bindings: RecoilCallbackBindings = {
    contextNames: new Set(), snapshotNames: new Set(), getNames: new Set(), setNames: new Set(), resetNames: new Set(),
  };

  const contextParameter = callbackFactory.getParameters()[0];
  if (!contextParameter) return bindings;

  const parameterNameNode = contextParameter.getNameNode();
  if (Node.isIdentifier(parameterNameNode)) {
    bindings.contextNames.add(parameterNameNode.getText());
    return bindings;
  }

  if (!Node.isObjectBindingPattern(parameterNameNode)) return bindings;

  for (const element of parameterNameNode.getElements()) {
    const propertyName = element.getPropertyNameNode()?.getText() ?? element.getName();
    const localNameNode = element.getNameNode();

    if (propertyName === "set") { collectIdentifiersFromBindingName(localNameNode, bindings.setNames); continue; }
    if (propertyName === "reset") { collectIdentifiersFromBindingName(localNameNode, bindings.resetNames); continue; }
    if (propertyName !== "snapshot") continue;

    if (Node.isIdentifier(localNameNode)) { bindings.snapshotNames.add(localNameNode.getText()); continue; }
    if (!Node.isObjectBindingPattern(localNameNode)) continue;

    for (const snapshotElement of localNameNode.getElements()) {
      const snapshotPropertyName = snapshotElement.getPropertyNameNode()?.getText() ?? snapshotElement.getName();
      if (RECOIL_SNAPSHOT_READ_METHODS.has(snapshotPropertyName)) {
        collectIdentifiersFromBindingName(snapshotElement.getNameNode(), bindings.getNames);
      }
    }
  }

  return bindings;
}

function parseJotaiAtomCallbackBindings(callbackFactory: CallbackFactoryFunction): JotaiAtomCallbackBindings {
  return {
    getName: getParameterNameOrDefault(callbackFactory.getParameters()[0], "get"),
    setName: getParameterNameOrDefault(callbackFactory.getParameters()[1], "set"),
  };
}

/* ------------------------------------------------------------------ */
/*  Read/Write classifiers                                            */
/* ------------------------------------------------------------------ */

function classifyRecoilCallbackRead(callExpression: CallExpression, bindings: RecoilCallbackBindings, index: SymbolIndex): UsageEvent | undefined {
  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) return undefined;

  const callee = callExpression.getExpression();
  let via: string | undefined;

  if (Node.isIdentifier(callee) && bindings.getNames.has(callee.getText())) via = `recoil:snapshot.${callee.getText()}`;
  if (Node.isPropertyAccessExpression(callee)) {
    const methodName = callee.getName();
    if (RECOIL_SNAPSHOT_READ_METHODS.has(methodName) && isRecoilSnapshotBase(callee.getExpression(), bindings)) via = `recoil:snapshot.${methodName}`;
  }

  if (!via) return undefined;
  return createRuntimeReadEvent(callExpression, targetState.id, via);
}

function classifyRecoilCallbackWrite(callExpression: CallExpression, bindings: RecoilCallbackBindings, index: SymbolIndex): UsageEvent | undefined {
  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) return undefined;

  const mutationKind = resolveRecoilCallbackMutationKind(callExpression.getExpression(), bindings);
  if (!mutationKind) return undefined;

  const [runtimeVia, initVia] = getMutationVias(mutationKind);
  return createWriteEvent(callExpression, targetState.id, runtimeVia, initVia);
}

function classifyJotaiAtomCallbackRead(callExpression: CallExpression, bindings: JotaiAtomCallbackBindings, index: SymbolIndex): UsageEvent | undefined {
  const callee = callExpression.getExpression();
  if (!Node.isIdentifier(callee) || callee.getText() !== bindings.getName) return undefined;
  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) return undefined;
  return createRuntimeReadEvent(callExpression, targetState.id, "jotai:useAtomCallback:get");
}

function classifyJotaiAtomCallbackWrite(callExpression: CallExpression, bindings: JotaiAtomCallbackBindings, index: SymbolIndex): UsageEvent | undefined {
  const callee = callExpression.getExpression();
  if (!Node.isIdentifier(callee) || callee.getText() !== bindings.setName) return undefined;
  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) return undefined;
  return createWriteEvent(callExpression, targetState.id, "set-call", "initializeState:set");
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function resolveCallbackFactoryFunction(callbackArgument: Node | undefined, importMap: ImportMap): CallbackFactoryFunction | undefined {
  if (!callbackArgument) return undefined;
  const directFunction = resolveFunctionFromNode(callbackArgument);
  if (directFunction) return directFunction;

  if (!Node.isCallExpression(callbackArgument)) return undefined;
  const callbackFactory = resolveCalledFactory(callbackArgument, importMap);
  if (!callbackFactory || callbackFactory.module !== "react" || callbackFactory.imported !== "useCallback") return undefined;
  return resolveFunctionFromNode(callbackArgument.getArguments()[0]);
}

function resolveFunctionFromNode(node: Node | undefined): CallbackFactoryFunction | undefined {
  if (!node) return undefined;
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node)) return node;
  if (!Node.isIdentifier(node)) return undefined;

  const symbol = node.getSymbol()?.getAliasedSymbol() ?? node.getSymbol();
  if (!symbol) return undefined;

  for (const declaration of symbol.getDeclarations()) {
    if (Node.isFunctionDeclaration(declaration)) return declaration;
    if (Node.isVariableDeclaration(declaration)) {
      const initializer = declaration.getInitializer();
      if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) return initializer;
    }
  }
  return undefined;
}

function resolveRecoilCallbackMutationKind(callee: Expression, bindings: RecoilCallbackBindings): "set" | "reset" | undefined {
  if (Node.isIdentifier(callee)) {
    if (bindings.setNames.has(callee.getText())) return "set";
    if (bindings.resetNames.has(callee.getText())) return "reset";
    return undefined;
  }
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  const methodName = callee.getName();
  if (methodName !== "set" && methodName !== "reset") return undefined;
  const base = callee.getExpression();
  if (!Node.isIdentifier(base) || !bindings.contextNames.has(base.getText())) return undefined;
  return methodName;
}

function isRecoilSnapshotBase(baseExpression: Expression, bindings: RecoilCallbackBindings): boolean {
  if (Node.isIdentifier(baseExpression)) return bindings.snapshotNames.has(baseExpression.getText());
  if (Node.isPropertyAccessExpression(baseExpression)) {
    return baseExpression.getName() === "snapshot" && Node.isIdentifier(baseExpression.getExpression()) && bindings.contextNames.has(baseExpression.getExpression().getText());
  }
  return false;
}

function getParameterNameOrDefault(parameter: ReturnType<CallbackFactoryFunction["getParameters"]>[number] | undefined, fallbackName: string): string {
  const nameNode = parameter?.getNameNode();
  if (nameNode && Node.isIdentifier(nameNode)) return nameNode.getText();
  return fallbackName;
}
