import {
  Node,
  SyntaxKind,
  type ArrowFunction,
  type CallExpression,
  type FunctionExpression,
  type SourceFile,
  type Symbol as MorphSymbol,
} from "ts-morph";
import {
  resolveCalledFactory,
  resolveStateFromExpression,
  type ImportMap,
  type SymbolIndex,
} from "./symbols";
import type { DependencyEdge, UsageEvent } from "./types";

export interface EventExtractionResult {
  usageEvents: UsageEvent[];
  dependencyEdges: DependencyEdge[];
}

export function buildUsageEvents(sourceFiles: SourceFile[], index: SymbolIndex): EventExtractionResult {
  const usageEvents: UsageEvent[] = [];
  const dependencyEdges: DependencyEdge[] = [];

  const setterSymbolToStateId = buildSetterBindings(sourceFiles, index);

  for (const sourceFile of sourceFiles) {
    const importMap = index.importMapByFilePath.get(sourceFile.getFilePath());

    for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const runtimeRead = importMap ? classifyRuntimeRead(callExpression, importMap, index) : undefined;
      if (runtimeRead) {
        usageEvents.push(runtimeRead);
      }

      const hookWrite = importMap ? classifyHookWritePotential(callExpression, importMap, index) : undefined;
      if (hookWrite) {
        usageEvents.push(hookWrite);
      }

      const setterWrite = classifySetterWriteCall(callExpression, setterSymbolToStateId);
      if (setterWrite) {
        usageEvents.push(setterWrite);
      }

      const directSetWrite = classifyDirectSetWrite(callExpression, index);
      if (directSetWrite) {
        usageEvents.push(directSetWrite);
      }
    }
  }

  for (const ownerState of index.states) {
    if (ownerState.store === "recoil" && (ownerState.kind === "selector" || ownerState.kind === "selectorFamily")) {
      const initCall = index.initCallByStateId.get(ownerState.id);
      if (!initCall) {
        continue;
      }

      const readFunctions = getRecoilReadFunctions(initCall);
      for (const readFunction of readFunctions) {
        for (const getCall of readFunction.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          if (!isRecoilGetCall(getCall)) {
            continue;
          }
          const targetState = resolveStateFromExpression(getCall.getArguments()[0], index);
          if (!targetState) {
            continue;
          }

          const location = getLocation(getCall);
          dependencyEdges.push({
            fromStateId: ownerState.id,
            toStateId: targetState.id,
            filePath: getCall.getSourceFile().getFilePath(),
            line: location.line,
            column: location.column,
            via: "recoil:get",
          });

          usageEvents.push({
            type: "read",
            phase: "dependency",
            stateId: targetState.id,
            actorType: "state",
            actorName: ownerState.name,
            actorStateId: ownerState.id,
            filePath: getCall.getSourceFile().getFilePath(),
            line: location.line,
            column: location.column,
            via: "recoil:get",
          });
        }
      }
    }

    if (ownerState.store === "jotai" && (ownerState.kind === "derivedAtom" || ownerState.kind === "atomWithDefault")) {
      const initCall = index.initCallByStateId.get(ownerState.id);
      if (!initCall) {
        continue;
      }

      const readFunction = getJotaiReadFunction(initCall);
      if (!readFunction) {
        continue;
      }

      const getParamName = getJotaiGetParameterName(readFunction);
      for (const getCall of readFunction.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (!isJotaiGetCall(getCall, getParamName)) {
          continue;
        }
        const targetState = resolveStateFromExpression(getCall.getArguments()[0], index);
        if (!targetState) {
          continue;
        }

        const location = getLocation(getCall);
        dependencyEdges.push({
          fromStateId: ownerState.id,
          toStateId: targetState.id,
          filePath: getCall.getSourceFile().getFilePath(),
          line: location.line,
          column: location.column,
          via: "jotai:get",
        });

        usageEvents.push({
          type: "read",
          phase: "dependency",
          stateId: targetState.id,
          actorType: "state",
          actorName: ownerState.name,
          actorStateId: ownerState.id,
          filePath: getCall.getSourceFile().getFilePath(),
          line: location.line,
          column: location.column,
          via: "jotai:get",
        });
      }
    }
  }

  return {
    usageEvents: dedupeUsageEvents(usageEvents),
    dependencyEdges: dedupeDependencyEdges(dependencyEdges),
  };
}

function buildSetterBindings(sourceFiles: SourceFile[], index: SymbolIndex): Map<string, string> {
  const setterSymbolToStateId = new Map<string, string>();

  for (const sourceFile of sourceFiles) {
    const importMap = index.importMapByFilePath.get(sourceFile.getFilePath());
    if (!importMap) {
      continue;
    }

    for (const declaration of sourceFile.getVariableDeclarations()) {
      const initCall = declaration.getInitializerIfKind(SyntaxKind.CallExpression);
      if (!initCall) {
        continue;
      }

      const factory = resolveCalledFactory(initCall, importMap);
      if (!factory) {
        continue;
      }

      const isSetHook =
        (factory.module === "recoil" &&
          (factory.imported === "useSetRecoilState" || factory.imported === "useRecoilState")) ||
        (factory.module === "jotai" && (factory.imported === "useSetAtom" || factory.imported === "useAtom"));

      if (!isSetHook) {
        continue;
      }

      const targetState = resolveStateFromExpression(initCall.getArguments()[0], index);
      if (!targetState) {
        continue;
      }

      if (factory.imported === "useSetRecoilState" || factory.imported === "useSetAtom") {
        const nameNode = declaration.getNameNode();
        if (Node.isIdentifier(nameNode)) {
          const symbolKey = getSymbolKey(nameNode);
          if (symbolKey) {
            setterSymbolToStateId.set(`sym|${symbolKey}`, targetState.id);
          }
          setterSymbolToStateId.set(
            getFallbackSetterKey(sourceFile.getFilePath(), nameNode.getText()),
            targetState.id,
          );
        }
        continue;
      }

      const nameNode = declaration.getNameNode();
      if (!Node.isArrayBindingPattern(nameNode)) {
        continue;
      }

      const secondElement = nameNode.getElements()[1];
      if (!secondElement || !Node.isBindingElement(secondElement)) {
        continue;
      }

      const secondName = secondElement.getNameNode();
      if (!Node.isIdentifier(secondName)) {
        continue;
      }

      const symbolKey = getSymbolKey(secondName);
      if (symbolKey) {
        setterSymbolToStateId.set(`sym|${symbolKey}`, targetState.id);
      }
      setterSymbolToStateId.set(
        getFallbackSetterKey(sourceFile.getFilePath(), secondName.getText()),
        targetState.id,
      );
    }
  }

  return setterSymbolToStateId;
}

function classifyRuntimeRead(
  callExpression: CallExpression,
  importMap: ImportMap,
  index: SymbolIndex,
): UsageEvent | undefined {
  const factory = resolveCalledFactory(callExpression, importMap);
  if (!factory) {
    return undefined;
  }

  const isReadHook =
    (factory.module === "recoil" &&
      (factory.imported === "useRecoilValue" ||
        factory.imported === "useRecoilValueLoadable" ||
        factory.imported === "useRecoilState" ||
        factory.imported === "useRecoilStateLoadable")) ||
    (factory.module === "jotai" &&
      (factory.imported === "useAtomValue" || factory.imported === "useAtom"));

  if (!isReadHook) {
    return undefined;
  }

  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) {
    return undefined;
  }

  const location = getLocation(callExpression);
  return {
    type: "read",
    phase: "runtime",
    stateId: targetState.id,
    actorType: "function",
    actorName: getContainingFunctionName(callExpression),
    filePath: callExpression.getSourceFile().getFilePath(),
    line: location.line,
    column: location.column,
    via: `${factory.module}:${factory.imported}`,
  };
}

function classifyHookWritePotential(
  callExpression: CallExpression,
  importMap: ImportMap,
  index: SymbolIndex,
): UsageEvent | undefined {
  const factory = resolveCalledFactory(callExpression, importMap);
  if (!factory) {
    return undefined;
  }

  const isWriteCapableHook =
    (factory.module === "recoil" &&
      (factory.imported === "useRecoilState" || factory.imported === "useSetRecoilState")) ||
    (factory.module === "jotai" && (factory.imported === "useAtom" || factory.imported === "useSetAtom"));

  if (!isWriteCapableHook) {
    return undefined;
  }

  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) {
    return undefined;
  }

  const location = getLocation(callExpression);
  return {
    type: "runtimeWrite",
    phase: "runtime",
    stateId: targetState.id,
    actorType: "function",
    actorName: getContainingFunctionName(callExpression),
    filePath: callExpression.getSourceFile().getFilePath(),
    line: location.line,
    column: location.column,
    via: `${factory.module}:${factory.imported}:hook`,
  };
}

function classifySetterWriteCall(
  callExpression: CallExpression,
  setterSymbolToStateId: Map<string, string>,
): UsageEvent | undefined {
  const callee = callExpression.getExpression();
  if (!Node.isIdentifier(callee)) {
    return undefined;
  }

  const symbolKey = getSymbolKey(callee);
  const targetStateId =
    (symbolKey ? setterSymbolToStateId.get(`sym|${symbolKey}`) : undefined) ??
    setterSymbolToStateId.get(getFallbackSetterKey(callExpression.getSourceFile().getFilePath(), callee.getText()));
  if (!targetStateId) {
    return undefined;
  }

  const location = getLocation(callExpression);
  return {
    type: "runtimeWrite",
    phase: "runtime",
    stateId: targetStateId,
    actorType: "function",
    actorName: getContainingFunctionName(callExpression),
    filePath: callExpression.getSourceFile().getFilePath(),
    line: location.line,
    column: location.column,
    via: "hook-setter-call",
  };
}

function classifyDirectSetWrite(callExpression: CallExpression, index: SymbolIndex): UsageEvent | undefined {
  const callee = callExpression.getExpression();
  const isSetCall =
    (Node.isIdentifier(callee) && callee.getText() === "set") ||
    (Node.isPropertyAccessExpression(callee) && callee.getName() === "set");
  if (!isSetCall) {
    return undefined;
  }

  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) {
    return undefined;
  }

  const location = getLocation(callExpression);
  const initContext = isInitWriteContext(callExpression);

  return {
    type: initContext ? "initWrite" : "runtimeWrite",
    phase: "runtime",
    stateId: targetState.id,
    actorType: "function",
    actorName: getContainingFunctionName(callExpression),
    filePath: callExpression.getSourceFile().getFilePath(),
    line: location.line,
    column: location.column,
    via: initContext ? "initializeState:set" : "set-call",
  };
}

function getRecoilReadFunctions(callExpression: CallExpression): Array<ArrowFunction | FunctionExpression> {
  const optionsArg = callExpression.getArguments()[0];
  if (!optionsArg || !Node.isObjectLiteralExpression(optionsArg)) {
    return [];
  }

  const results: Array<ArrowFunction | FunctionExpression> = [];
  const getProperty = optionsArg
    .getProperties()
    .find((property) =>
      (Node.isPropertyAssignment(property) || Node.isMethodDeclaration(property)) &&
      property.getName() === "get",
    );

  if (!getProperty) {
    return results;
  }

  if (Node.isMethodDeclaration(getProperty)) {
    const body = getProperty.getBody();
    if (!body) {
      return results;
    }
    return body
      .getDescendants()
      .filter((node): node is ArrowFunction | FunctionExpression =>
        Node.isArrowFunction(node) || Node.isFunctionExpression(node),
      );
  }

  if (!Node.isPropertyAssignment(getProperty)) {
    return results;
  }

  const initializer = getProperty.getInitializer();
  if (!initializer) {
    return results;
  }

  if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
    results.push(initializer);

    for (const nested of initializer
      .getDescendants()
      .filter((node): node is ArrowFunction | FunctionExpression =>
        Node.isArrowFunction(node) || Node.isFunctionExpression(node),
      )) {
      if (nested !== initializer) {
        results.push(nested);
      }
    }
  }

  return results;
}

function getJotaiReadFunction(callExpression: CallExpression): ArrowFunction | FunctionExpression | undefined {
  const firstArg = callExpression.getArguments()[0];
  if (!firstArg) {
    return undefined;
  }

  if (Node.isArrowFunction(firstArg) || Node.isFunctionExpression(firstArg)) {
    return firstArg;
  }

  return undefined;
}

function getJotaiGetParameterName(functionNode: ArrowFunction | FunctionExpression): string {
  const firstParameter = functionNode.getParameters()[0];
  const parameterNameNode = firstParameter?.getNameNode();
  if (parameterNameNode && Node.isIdentifier(parameterNameNode)) {
    return parameterNameNode.getText();
  }
  return "get";
}

function isRecoilGetCall(callExpression: CallExpression): boolean {
  const callee = callExpression.getExpression();
  if (Node.isIdentifier(callee)) {
    return callee.getText() === "get";
  }
  if (Node.isPropertyAccessExpression(callee)) {
    return callee.getName() === "get";
  }
  return false;
}

function isJotaiGetCall(callExpression: CallExpression, getParamName: string): boolean {
  const callee = callExpression.getExpression();
  return Node.isIdentifier(callee) && callee.getText() === getParamName;
}

function isInitWriteContext(node: Node): boolean {
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

function getContainingFunctionName(node: Node): string {
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

function getLocation(node: Node): { line: number; column: number } {
  const position = node.getSourceFile().getLineAndColumnAtPos(node.getStart());
  return {
    line: position.line,
    column: position.column,
  };
}

function dedupeUsageEvents(events: UsageEvent[]): UsageEvent[] {
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

function dedupeDependencyEdges(edges: DependencyEdge[]): DependencyEdge[] {
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

function getSymbolKey(node: Node): string | undefined {
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

function unwrapAliasedSymbol(symbol: MorphSymbol | undefined): MorphSymbol | undefined {
  if (!symbol) {
    return undefined;
  }
  return symbol.getAliasedSymbol() ?? symbol;
}

function getFallbackSetterKey(filePath: string, setterName: string): string {
  return `name|${filePath}|${setterName}`;
}
