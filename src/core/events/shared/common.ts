import {
  Node,
  SyntaxKind,
  type ArrowFunction,
  type BindingName,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type Symbol as MorphSymbol,
} from "ts-morph";
import type { DependencyEdge, UsageEvent } from "../../types";

export type CallbackFactoryFunction = ArrowFunction | FunctionExpression | FunctionDeclaration;
export type FunctionLikeNode = ArrowFunction | FunctionExpression | FunctionDeclaration | MethodDeclaration;
export type WriteEventType = "runtimeWrite" | "initWrite";

export interface RecoilCallbackBindings {
  contextNames: Set<string>;
  snapshotNames: Set<string>;
  getNames: Set<string>;
  setNames: Set<string>;
  resetNames: Set<string>;
}

export interface JotaiAtomCallbackBindings {
  getName: string;
  setName: string;
}

export interface RecoilReadScope {
  scopeNode: FunctionLikeNode;
  getNames: Set<string>;
  contextNames: Set<string>;
}

export const RECOIL_SNAPSHOT_READ_METHODS = new Set(["get", "getPromise", "getLoadable"]);
export const RECOIL_SETTER_FACTORIES = new Set(["useSetRecoilState", "useResetRecoilState"]);
export const RECOIL_TUPLE_FACTORIES = new Set(["useRecoilState", "useRecoilStateLoadable"]);
export const RECOIL_READ_FACTORIES = new Set(["useRecoilValue", "useRecoilValueLoadable", ...RECOIL_TUPLE_FACTORIES]);
export const JOTAI_SETTER_FACTORIES = new Set(["useSetAtom"]);
export const JOTAI_TUPLE_FACTORIES = new Set(["useAtom"]);
export const JOTAI_READ_FACTORIES = new Set(["useAtomValue", ...JOTAI_TUPLE_FACTORIES]);

export function getLocation(node: Node): { line: number; column: number } {
  const position = node.getSourceFile().getLineAndColumnAtPos(node.getStart());
  return {
    line: position.line,
    column: position.column,
  };
}

export function createRuntimeReadEvent(node: Node, stateId: string, via: string): UsageEvent {
  const location = getLocation(node);
  return {
    type: "read",
    phase: "runtime",
    stateId,
    actorType: "function",
    actorName: getContainingFunctionName(node),
    filePath: node.getSourceFile().getFilePath(),
    line: location.line,
    column: location.column,
    via,
  };
}

export function createWriteEvent(node: Node, stateId: string, runtimeVia: string, initVia: string): UsageEvent {
  const location = getLocation(node);
  const writeType = classifyWriteType(node);
  return {
    type: writeType,
    phase: "runtime",
    stateId,
    actorType: "function",
    actorName: getContainingFunctionName(node),
    filePath: node.getSourceFile().getFilePath(),
    line: location.line,
    column: location.column,
    via: writeType === "initWrite" ? initVia : runtimeVia,
  };
}

export function getMutationVias(mutationKind: "set" | "reset"): [runtime: string, init: string] {
  return mutationKind === "set" ? ["set-call", "initializeState:set"] : ["reset-call", "initializeState:reset"];
}

export function resolveMutationKind(callee: Expression): "set" | "reset" | undefined {
  if (Node.isIdentifier(callee)) {
    const name = callee.getText();
    if (name === "set" || name === "reset") {
      return name;
    }
    return undefined;
  }

  if (Node.isPropertyAccessExpression(callee)) {
    const name = callee.getName();
    if (name === "set" || name === "reset") {
      return name;
    }
  }

  return undefined;
}

export function classifyWriteType(node: Node): WriteEventType {
  return isInitWriteContext(node) ? "initWrite" : "runtimeWrite";
}

export function isSetterReferenceWriteSite(identifier: Node): boolean {
  if (!Node.isIdentifier(identifier)) {
    return false;
  }

  const parent = identifier.getParent();
  if (!parent || !Node.isJsxExpression(parent)) {
    return false;
  }

  const attribute = parent.getParent();
  return Node.isJsxAttribute(attribute) && attribute.getNameNode().getText().startsWith("on");
}

export function getContainingFunctionName(node: Node): string {
  const namedFunction = node.getFirstAncestor((ancestor) => {
    if (Node.isFunctionDeclaration(ancestor)) {
      return Boolean(ancestor.getName());
    }
    if (Node.isMethodDeclaration(ancestor)) {
      return true;
    }
    if (Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor)) {
      const variable = ancestor.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      return Boolean(variable?.getName());
    }
    return false;
  });

  if (!namedFunction) {
    return "<anonymous>";
  }

  if (Node.isFunctionDeclaration(namedFunction)) {
    return namedFunction.getName() ?? "<anonymous>";
  }

  if (Node.isMethodDeclaration(namedFunction)) {
    return namedFunction.getName();
  }

  const variable = namedFunction.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  return variable?.getName() ?? "<anonymous>";
}

export function getFunctionLikeName(node: FunctionLikeNode): string | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
    return node.getName() ?? undefined;
  }

  const variableDeclaration = node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (variableDeclaration) {
    return variableDeclaration.getName();
  }

  return undefined;
}

export function isFunctionLikeNode(node: Node): node is FunctionLikeNode {
  return (
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node)
  );
}

export function collectIdentifiersFromBindingName(bindingName: BindingName, target: Set<string>): void {
  if (Node.isIdentifier(bindingName)) {
    target.add(bindingName.getText());
    return;
  }

  if (Node.isObjectBindingPattern(bindingName)) {
    for (const element of bindingName.getElements()) {
      collectIdentifiersFromBindingName(element.getNameNode(), target);
    }
  }
}

export function getSymbolKey(node: Node): string | undefined {
  const symbol = unwrapAliasedSymbol(node.getSymbol());
  if (!symbol) {
    return undefined;
  }

  const declaration = symbol.getDeclarations()[0];
  if (!declaration) {
    return symbol.getFullyQualifiedName();
  }

  return `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}:${symbol.getName()}`;
}

export function unwrapAliasedSymbol(symbol: MorphSymbol | undefined): MorphSymbol | undefined {
  if (!symbol) {
    return undefined;
  }
  return symbol.getAliasedSymbol() ?? symbol;
}

export function getFallbackSetterKey(filePath: string, setterName: string): string {
  return `name|${filePath}|${setterName}`;
}

export function resolveFunctionLikeNodesFromExpression(expression: Node): FunctionLikeNode[] {
  if (!Node.isIdentifier(expression) && !Node.isPropertyAccessExpression(expression)) {
    return [];
  }

  const symbol = unwrapAliasedSymbol(expression.getSymbol());
  if (!symbol) {
    return [];
  }

  const nodes: FunctionLikeNode[] = [];
  for (const declaration of symbol.getDeclarations()) {
    if (Node.isFunctionDeclaration(declaration)) {
      nodes.push(declaration);
      continue;
    }
    if (Node.isMethodDeclaration(declaration)) {
      nodes.push(declaration);
      continue;
    }
    if (!Node.isVariableDeclaration(declaration)) {
      continue;
    }

    const initializer = declaration.getInitializer();
    if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
      nodes.push(initializer);
    }
  }

  return nodes;
}

export function getFunctionLikeNodeKey(functionNode: FunctionLikeNode): string {
  return `${functionNode.getSourceFile().getFilePath()}:${functionNode.getStart()}`;
}

export function isInFunctionOwnScope(node: Node, functionNode: FunctionLikeNode): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (isFunctionLikeNode(current)) {
      return current === functionNode;
    }
    current = current.getParent();
  }
  return false;
}

export function getJsxTagNameNode(jsxAttribute: Node): Node | undefined {
  if (!Node.isJsxAttribute(jsxAttribute)) {
    return undefined;
  }

  const attributesNode = jsxAttribute.getParent();
  if (!attributesNode || attributesNode.getKind() !== SyntaxKind.JsxAttributes) {
    return undefined;
  }

  const openingElement = attributesNode.getParent();
  if (Node.isJsxSelfClosingElement(openingElement)) {
    return openingElement.getTagNameNode();
  }
  if (Node.isJsxOpeningElement(openingElement)) {
    return openingElement.getTagNameNode();
  }

  return undefined;
}

export function pushIfDefined<T>(items: T[], item: T | undefined): void {
  if (item) {
    items.push(item);
  }
}

export function dedupeUsageEvents(events: UsageEvent[]): UsageEvent[] {
  const unique = new Map<string, UsageEvent>();
  for (const event of events) {
    const key = [
      event.type,
      event.phase,
      event.stateId,
      event.actorType,
      event.actorName,
      event.filePath,
      event.line,
      event.column,
      event.via,
    ].join("|");
    if (!unique.has(key)) {
      unique.set(key, event);
    }
  }

  return [...unique.values()].sort((left, right) => {
    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    if (left.column !== right.column) {
      return left.column - right.column;
    }
    if (left.type !== right.type) {
      return left.type.localeCompare(right.type);
    }
    return left.stateId.localeCompare(right.stateId);
  });
}

export function dedupeDependencyEdges(edges: DependencyEdge[]): DependencyEdge[] {
  const unique = new Map<string, DependencyEdge>();
  for (const edge of edges) {
    const key = [edge.fromStateId, edge.toStateId, edge.filePath, edge.line, edge.column, edge.via].join("|");
    if (!unique.has(key)) {
      unique.set(key, edge);
    }
  }

  return [...unique.values()].sort((left, right) => {
    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    if (left.column !== right.column) {
      return left.column - right.column;
    }
    if (left.fromStateId !== right.fromStateId) {
      return left.fromStateId.localeCompare(right.fromStateId);
    }
    return left.toStateId.localeCompare(right.toStateId);
  });
}

function isInitWriteContext(node: Node): boolean {
  if (isInsideInitializeStateProperty(node)) {
    return true;
  }

  let current: Node | undefined = node;
  while (current) {
    if (isFunctionLikeNode(current)) {
      const functionName = getFunctionLikeName(current);
      if (functionName && functionName.startsWith("initialize")) {
        return true;
      }
    }
    current = current.getParent();
  }

  return false;
}

function isInsideInitializeStateProperty(node: Node): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isJsxAttribute(current) && current.getNameNode().getText() === "initializeState") {
      return true;
    }
    if (Node.isPropertyAssignment(current) && current.getName() === "initializeState") {
      return true;
    }
    current = current.getParent();
  }

  return false;
}
