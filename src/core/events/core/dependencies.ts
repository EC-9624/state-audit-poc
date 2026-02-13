import { Node, SyntaxKind, type CallExpression, type Expression } from "ts-morph";
import { resolveCalledFactory, resolveStateFromExpression, type SymbolIndex } from "../../symbols";
import type { DependencyEdge, UsageEvent } from "../../types";
import {
  collectIdentifiersFromBindingName,
  getFallbackSetterKey,
  getLocation,
  isInFunctionOwnScope,
  resolveFunctionLikeNodesFromExpression,
  getSymbolKey,
  isFunctionLikeNode,
  type FunctionLikeNode,
  type RecoilReadScope,
} from "../shared/common";
import type { EventExtractor, EventPipelineContext } from "../types";

/* ------------------------------------------------------------------ */
/*  Public                                                            */
/* ------------------------------------------------------------------ */

export function buildDependencyEvents(
  index: SymbolIndex,
  jotaiStoreSymbolKeys: Set<string>,
): { usageEvents: UsageEvent[]; dependencyEdges: DependencyEdge[] } {
  const usageEvents: UsageEvent[] = [];
  const dependencyEdges: DependencyEdge[] = [];

  for (const ownerState of index.states) {
    if (ownerState.store === "recoil" && (ownerState.kind === "selector" || ownerState.kind === "selectorFamily")) {
      const initCall = index.initCallByStateId.get(ownerState.id);
      if (!initCall) continue;

      const readScopes = getRecoilReadScopes(initCall);
      collectRecoilDependencyReads(ownerState.id, ownerState.name, readScopes, jotaiStoreSymbolKeys, index, dependencyEdges, usageEvents);
    }

    const isRecoilDefaultSelectorOwner =
      ownerState.store === "recoil" &&
      (ownerState.kind === "atomFamily" || (ownerState.kind === "atom" && !ownerState.isRecoilPlainAtom));
    if (isRecoilDefaultSelectorOwner) {
      const initCall = index.initCallByStateId.get(ownerState.id);
      if (!initCall) continue;

      const defaultSelectorCall = getRecoilAtomDefaultSelectorCall(initCall, index);
      if (!defaultSelectorCall) continue;

      const readScopes = getRecoilReadScopes(defaultSelectorCall);
      collectRecoilDependencyReads(ownerState.id, ownerState.name, readScopes, jotaiStoreSymbolKeys, index, dependencyEdges, usageEvents);
    }

    if (ownerState.store === "jotai" && (ownerState.kind === "derivedAtom" || ownerState.kind === "atomWithDefault")) {
      const initCall = index.initCallByStateId.get(ownerState.id);
      if (!initCall) continue;

      const readFunction = getJotaiReadFunction(initCall);
      if (!readFunction) continue;

      collectJotaiDependencyReads(ownerState.id, ownerState.name, readFunction, index, dependencyEdges, usageEvents);
    }

    if (ownerState.store === "jotai" && ownerState.kind === "atomFamily") {
      const initCall = index.initCallByStateId.get(ownerState.id);
      if (!initCall) continue;

      const readFunctions = getJotaiAtomFamilyReadFunctions(initCall, index);
      for (const readFunction of readFunctions) {
        collectJotaiDependencyReads(ownerState.id, ownerState.name, readFunction, index, dependencyEdges, usageEvents);
      }
    }
  }

  return { usageEvents, dependencyEdges };
}

/* ------------------------------------------------------------------ */
/*  Extractor                                                         */
/* ------------------------------------------------------------------ */

export const coreDependenciesExtractor: EventExtractor = {
  id: "core:dependencies",
  run(ctx: EventPipelineContext) {
    const result = buildDependencyEvents(ctx.index, ctx.jotaiStoreSymbolKeys);
    return { usageEvents: result.usageEvents, dependencyEdges: result.dependencyEdges };
  },
};

/* ------------------------------------------------------------------ */
/*  Internals                                                         */
/* ------------------------------------------------------------------ */

function collectRecoilDependencyReads(
  ownerStateId: string,
  ownerStateName: string,
  readScopes: RecoilReadScope[],
  jotaiStoreSymbolKeys: Set<string>,
  index: SymbolIndex,
  dependencyEdges: DependencyEdge[],
  usageEvents: UsageEvent[],
): void {
  for (const readScope of readScopes) {
    for (const callExpression of readScope.scopeNode.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
      if (!targetState) continue;

      if (isRecoilGetCall(callExpression, readScope.getNames, readScope.contextNames)) {
        pushDependencyRead(ownerStateId, ownerStateName, targetState.id, callExpression, "recoil:get", "recoil:get", dependencyEdges, usageEvents);
        continue;
      }

      if (isJotaiStoreGetCall(callExpression, jotaiStoreSymbolKeys)) {
        pushDependencyRead(ownerStateId, ownerStateName, targetState.id, callExpression, "jotai:get", "jotai:store.get", dependencyEdges, usageEvents);
      }
    }
  }
}

function collectJotaiDependencyReads(
  ownerStateId: string,
  ownerStateName: string,
  readFunction: Expression,
  index: SymbolIndex,
  dependencyEdges: DependencyEdge[],
  usageEvents: UsageEvent[],
): void {
  const getParamName = getJotaiGetParameterName(readFunction);
  for (const getCall of readFunction.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isJotaiGetCall(getCall, getParamName)) continue;
    const targetState = resolveStateFromExpression(getCall.getArguments()[0], index);
    if (!targetState) continue;

    pushDependencyRead(ownerStateId, ownerStateName, targetState.id, getCall, "jotai:get", "jotai:get", dependencyEdges, usageEvents);
  }
}

function pushDependencyRead(
  ownerStateId: string,
  ownerStateName: string,
  targetStateId: string,
  callExpression: CallExpression,
  edgeVia: DependencyEdge["via"],
  eventVia: string,
  dependencyEdges: DependencyEdge[],
  usageEvents: UsageEvent[],
): void {
  const location = getLocation(callExpression);

  dependencyEdges.push({
    fromStateId: ownerStateId,
    toStateId: targetStateId,
    filePath: callExpression.getSourceFile().getFilePath(),
    line: location.line,
    column: location.column,
    via: edgeVia,
  });

  usageEvents.push({
    type: "read",
    phase: "dependency",
    stateId: targetStateId,
    actorType: "state",
    actorName: ownerStateName,
    actorStateId: ownerStateId,
    filePath: callExpression.getSourceFile().getFilePath(),
    line: location.line,
    column: location.column,
    via: eventVia,
  });
}

function getRecoilAtomDefaultSelectorCall(atomCallExpression: CallExpression, index: SymbolIndex): CallExpression | undefined {
  const optionsArg = atomCallExpression.getArguments()[0];
  if (!optionsArg || !Node.isObjectLiteralExpression(optionsArg)) return undefined;

  const defaultProperty = optionsArg.getProperties().find((p) => Node.isPropertyAssignment(p) && p.getName() === "default");
  if (!defaultProperty || !Node.isPropertyAssignment(defaultProperty)) return undefined;

  const initializer = defaultProperty.getInitializer();
  if (!initializer) return undefined;

  if (Node.isCallExpression(initializer) && isRecoilSelectorFactoryCall(initializer, index)) return initializer;

  const referencedState = resolveStateFromExpression(initializer, index);
  if (!referencedState || referencedState.store !== "recoil" || (referencedState.kind !== "selector" && referencedState.kind !== "selectorFamily")) return undefined;

  return index.initCallByStateId.get(referencedState.id);
}

function isRecoilSelectorFactoryCall(callExpression: CallExpression, index: SymbolIndex): boolean {
  const importMap = index.importMapByFilePath.get(callExpression.getSourceFile().getFilePath());
  if (!importMap) return false;
  const factory = resolveCalledFactory(callExpression, importMap);
  if (!factory || factory.module !== "recoil") return false;
  return factory.imported === "selector" || factory.imported === "selectorFamily";
}

function getRecoilReadScopes(callExpression: CallExpression): RecoilReadScope[] {
  const optionsArg = callExpression.getArguments()[0];
  if (!optionsArg || !Node.isObjectLiteralExpression(optionsArg)) return [];

  const getProperty = optionsArg.getProperties().find((p) => (Node.isPropertyAssignment(p) || Node.isMethodDeclaration(p)) && p.getName() === "get");
  if (!getProperty) return [];

  const rootFunctions: FunctionLikeNode[] = [];
  if (Node.isMethodDeclaration(getProperty)) rootFunctions.push(getProperty);
  if (Node.isPropertyAssignment(getProperty)) {
    const init = getProperty.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) rootFunctions.push(init);
  }

  const scopes: RecoilReadScope[] = [];
  for (const rootFunction of rootFunctions) {
    for (const functionNode of getNestedFunctionNodes(rootFunction)) {
      const binding = extractRecoilGetBinding(functionNode);
      if (!binding) {
        if (functionNode === rootFunction) {
          scopes.push({ scopeNode: functionNode, getNames: new Set(), contextNames: new Set() });
        }
        continue;
      }
      scopes.push({ scopeNode: functionNode, getNames: binding.getNames, contextNames: binding.contextNames });
    }
  }

  return scopes;
}

function getNestedFunctionNodes(rootFunction: FunctionLikeNode): FunctionLikeNode[] {
  const nodes: FunctionLikeNode[] = [rootFunction];
  for (const descendant of rootFunction.getDescendants()) {
    if (isFunctionLikeNode(descendant)) nodes.push(descendant);
  }
  return nodes;
}

function extractRecoilGetBinding(functionNode: FunctionLikeNode): { getNames: Set<string>; contextNames: Set<string> } | undefined {
  const getNames = new Set<string>();
  const contextNames = new Set<string>();

  const firstParameter = functionNode.getParameters()[0];
  if (!firstParameter) return undefined;

  const parameterNameNode = firstParameter.getNameNode();
  if (Node.isIdentifier(parameterNameNode)) contextNames.add(parameterNameNode.getText());
  if (Node.isObjectBindingPattern(parameterNameNode)) {
    for (const element of parameterNameNode.getElements()) {
      const propertyName = element.getPropertyNameNode()?.getText() ?? element.getName();
      if (propertyName === "get") collectIdentifiersFromBindingName(element.getNameNode(), getNames);
    }
  }

  if (getNames.size === 0 && contextNames.size === 0) return undefined;
  return { getNames, contextNames };
}

function getJotaiReadFunction(callExpression: CallExpression): Expression | undefined {
  const firstArg = callExpression.getArguments()[0];
  if (!firstArg) return undefined;
  if (Node.isArrowFunction(firstArg) || Node.isFunctionExpression(firstArg)) return firstArg;
  return undefined;
}

function getJotaiAtomFamilyReadFunctions(atomFamilyCall: CallExpression, index: SymbolIndex): Expression[] {
  const familyFactoryArg = atomFamilyCall.getArguments()[0];
  const familyFactoryFunctions = resolveFunctionNodesFromExpression(familyFactoryArg);
  if (familyFactoryFunctions.length === 0) return [];

  const readFunctions: Expression[] = [];
  for (const familyFactoryFunction of familyFactoryFunctions) {
    for (const returnedCallExpression of getReturnedCallExpressions(familyFactoryFunction)) {
      if (!isJotaiDerivedFactoryCall(returnedCallExpression, index)) {
        continue;
      }
      const readFunction = getJotaiReadFunction(returnedCallExpression);
      if (readFunction) {
        readFunctions.push(readFunction);
      }
    }
  }

  return readFunctions;
}

function resolveFunctionNodesFromExpression(expression: Node | undefined): FunctionLikeNode[] {
  if (!expression) return [];

  if (
    Node.isArrowFunction(expression) ||
    Node.isFunctionExpression(expression) ||
    Node.isFunctionDeclaration(expression) ||
    Node.isMethodDeclaration(expression)
  ) {
    return [expression];
  }

  return resolveFunctionLikeNodesFromExpression(expression);
}

function getReturnedCallExpressions(functionNode: FunctionLikeNode): CallExpression[] {
  if ((Node.isArrowFunction(functionNode) || Node.isFunctionExpression(functionNode)) && !Node.isBlock(functionNode.getBody())) {
    const bodyExpression = functionNode.getBody();
    return Node.isCallExpression(bodyExpression) ? [bodyExpression] : [];
  }

  const body =
    Node.isFunctionDeclaration(functionNode) ||
    Node.isMethodDeclaration(functionNode) ||
    Node.isArrowFunction(functionNode) ||
    Node.isFunctionExpression(functionNode)
      ? functionNode.getBody()
      : undefined;
  if (!body || !Node.isBlock(body)) {
    return [];
  }

  const calls: CallExpression[] = [];
  for (const returnStatement of body.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    if (!isInFunctionOwnScope(returnStatement, functionNode)) {
      continue;
    }
    const expression = returnStatement.getExpression();
    if (expression && Node.isCallExpression(expression)) {
      calls.push(expression);
    }
  }

  return calls;
}

function isJotaiDerivedFactoryCall(callExpression: CallExpression, index: SymbolIndex): boolean {
  const importMap = index.importMapByFilePath.get(callExpression.getSourceFile().getFilePath());
  if (!importMap) return false;

  const factory = resolveCalledFactory(callExpression, importMap);
  if (!factory) return false;

  return (
    (factory.module === "jotai" && factory.imported === "atom") ||
    (factory.module === "jotai/utils" && factory.imported === "atomWithDefault")
  );
}

function getJotaiGetParameterName(functionNode: Expression): string {
  if (!Node.isArrowFunction(functionNode) && !Node.isFunctionExpression(functionNode)) return "get";
  const firstParameter = functionNode.getParameters()[0];
  const nameNode = firstParameter?.getNameNode();
  if (nameNode && Node.isIdentifier(nameNode)) return nameNode.getText();
  return "get";
}

function isRecoilGetCall(callExpression: CallExpression, getNames: Set<string>, contextNames: Set<string>): boolean {
  const callee = callExpression.getExpression();
  if (Node.isIdentifier(callee)) return getNames.has(callee.getText());
  if (Node.isPropertyAccessExpression(callee)) {
    if (callee.getName() !== "get") return false;
    const base = callee.getExpression();
    return Node.isIdentifier(base) && contextNames.has(base.getText());
  }
  return false;
}

function isJotaiGetCall(callExpression: CallExpression, getParamName: string): boolean {
  const callee = callExpression.getExpression();
  return Node.isIdentifier(callee) && callee.getText() === getParamName;
}

export function isJotaiStoreGetCall(callExpression: CallExpression, jotaiStoreSymbolKeys: Set<string>): boolean {
  const callee = callExpression.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "get") return false;
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
