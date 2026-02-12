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

type CallbackFactoryFunction = ArrowFunction | FunctionExpression | FunctionDeclaration;
type FunctionLikeNode = ArrowFunction | FunctionExpression | FunctionDeclaration | MethodDeclaration;
type WriteEventType = "runtimeWrite" | "initWrite";

interface RecoilCallbackBindings {
  contextNames: Set<string>;
  snapshotNames: Set<string>;
  getNames: Set<string>;
  setNames: Set<string>;
  resetNames: Set<string>;
}

interface JotaiAtomCallbackBindings {
  getName: string;
  setName: string;
}

type HookWriteBindingKind = "setter" | "tuple" | "object";

interface HookWriteBinding {
  kind: HookWriteBindingKind;
  stateId?: string;
  objectSetterStateByProp?: Map<string, string>;
}

const RECOIL_SNAPSHOT_READ_METHODS = new Set(["get", "getPromise", "getLoadable"]);

export interface EventExtractionResult {
  usageEvents: UsageEvent[];
  dependencyEdges: DependencyEdge[];
}

export function buildUsageEvents(sourceFiles: SourceFile[], index: SymbolIndex): EventExtractionResult {
  const usageEvents: UsageEvent[] = [];
  const dependencyEdges: DependencyEdge[] = [];

  const directSetterSymbolToStateId = buildSetterBindings(sourceFiles, index);
  const setterSymbolToStateId = propagateSetterBindingsOneHop(sourceFiles, directSetterSymbolToStateId);

  for (const sourceFile of sourceFiles) {
    const importMap = index.importMapByFilePath.get(sourceFile.getFilePath());

    for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const runtimeRead = importMap ? classifyRuntimeRead(callExpression, importMap, index) : undefined;
      if (runtimeRead) {
        usageEvents.push(runtimeRead);
      }

      const setterWrite = classifySetterWriteCall(callExpression, setterSymbolToStateId);
      if (setterWrite) {
        usageEvents.push(setterWrite);
      }

      const directMutationWrite = classifyDirectMutationWrite(callExpression, index);
      if (directMutationWrite) {
        usageEvents.push(directMutationWrite);
      }
    }

    if (importMap) {
      usageEvents.push(...extractRecoilCallbackEvents(sourceFile, importMap, index));
      usageEvents.push(...extractJotaiAtomCallbackEvents(sourceFile, importMap, index));
    }

    usageEvents.push(...extractSetterReferenceWriteEvents(sourceFile, setterSymbolToStateId));
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
  const hookBindingCache = new Map<string, HookWriteBinding | null>();
  const resolvingHookKeys = new Set<string>();

  for (const sourceFile of sourceFiles) {
    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const initCall = declaration.getInitializerIfKind(SyntaxKind.CallExpression);
      if (!initCall) {
        continue;
      }

      const hookBinding = resolveHookWriteBindingFromCallExpression(
        initCall,
        index,
        hookBindingCache,
        resolvingHookKeys,
      );
      if (!hookBinding) {
        continue;
      }

      bindSetterIdentifiersFromDeclaration(
        declaration,
        hookBinding,
        setterSymbolToStateId,
      );
    }
  }

  return setterSymbolToStateId;
}

function resolveHookWriteBindingFromCallExpression(
  callExpression: CallExpression,
  index: SymbolIndex,
  cache: Map<string, HookWriteBinding | null>,
  resolvingKeys: Set<string>,
): HookWriteBinding | undefined {
  const directBinding = resolveDirectHookWriteBinding(callExpression, index);
  if (directBinding) {
    return directBinding;
  }

  const functionNodes = resolveFunctionLikeNodesFromExpression(callExpression.getExpression());
  for (const functionNode of functionNodes) {
    const key = getFunctionLikeNodeKey(functionNode);

    const cached = cache.get(key);
    if (cached !== undefined) {
      if (cached) {
        return cached;
      }
      continue;
    }

    if (resolvingKeys.has(key)) {
      continue;
    }

    resolvingKeys.add(key);
    const analyzed = analyzeHookWrapperFunction(functionNode, index, cache, resolvingKeys);
    cache.set(key, analyzed ?? null);
    resolvingKeys.delete(key);

    if (analyzed) {
      return analyzed;
    }
  }

  return undefined;
}

function resolveDirectHookWriteBinding(
  callExpression: CallExpression,
  index: SymbolIndex,
): HookWriteBinding | undefined {
  const importMap = index.importMapByFilePath.get(callExpression.getSourceFile().getFilePath());
  if (!importMap) {
    return undefined;
  }

  const factory = resolveCalledFactory(callExpression, importMap);
  if (!factory) {
    return undefined;
  }

  const setterFactories = new Set(["useSetRecoilState", "useResetRecoilState"]);
  if (factory.module === "recoil" && setterFactories.has(factory.imported)) {
    const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
    if (!targetState) {
      return undefined;
    }
    return {
      kind: "setter",
      stateId: targetState.id,
    };
  }

  if (factory.module === "jotai" && factory.imported === "useSetAtom") {
    const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
    if (!targetState) {
      return undefined;
    }
    return {
      kind: "setter",
      stateId: targetState.id,
    };
  }

  const tupleFactories = new Set(["useRecoilState", "useRecoilStateLoadable"]);
  if (factory.module === "recoil" && tupleFactories.has(factory.imported)) {
    const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
    if (!targetState) {
      return undefined;
    }
    return {
      kind: "tuple",
      stateId: targetState.id,
    };
  }

  if (factory.module === "jotai" && factory.imported === "useAtom") {
    const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
    if (!targetState) {
      return undefined;
    }
    return {
      kind: "tuple",
      stateId: targetState.id,
    };
  }

  return undefined;
}

function analyzeHookWrapperFunction(
  functionNode: FunctionLikeNode,
  index: SymbolIndex,
  cache: Map<string, HookWriteBinding | null>,
  resolvingKeys: Set<string>,
): HookWriteBinding | undefined {
  const localValueBindings = new Map<string, HookWriteBinding>();
  const localSetterByName = new Map<string, string>();

  for (const declaration of functionNode.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (!isInFunctionOwnScope(declaration, functionNode)) {
      continue;
    }

    const initializerCall = declaration.getInitializerIfKind(SyntaxKind.CallExpression);
    if (!initializerCall) {
      continue;
    }

    const binding = resolveHookWriteBindingFromCallExpression(initializerCall, index, cache, resolvingKeys);
    if (!binding) {
      continue;
    }

    registerLocalHookBindingFromDeclaration(
      declaration,
      binding,
      localValueBindings,
      localSetterByName,
    );
  }

  for (const returnExpression of getReturnExpressions(functionNode)) {
    const binding = resolveHookWriteBindingFromReturnExpression(
      returnExpression,
      index,
      cache,
      resolvingKeys,
      localValueBindings,
      localSetterByName,
    );
    if (binding) {
      return binding;
    }
  }

  return undefined;
}

function registerLocalHookBindingFromDeclaration(
  declaration: Node,
  binding: HookWriteBinding,
  localValueBindings: Map<string, HookWriteBinding>,
  localSetterByName: Map<string, string>,
): void {
  if (!Node.isVariableDeclaration(declaration)) {
    return;
  }

  const nameNode = declaration.getNameNode();
  if (Node.isIdentifier(nameNode)) {
    localValueBindings.set(nameNode.getText(), binding);

    if (binding.kind === "setter" && binding.stateId) {
      localSetterByName.set(nameNode.getText(), binding.stateId);
    }
    return;
  }

  if (Node.isArrayBindingPattern(nameNode) && binding.kind === "tuple" && binding.stateId) {
    const setterElement = nameNode.getElements()[1];
    if (!setterElement || !Node.isBindingElement(setterElement)) {
      return;
    }
    const setterName = setterElement.getNameNode();
    if (Node.isIdentifier(setterName)) {
      localSetterByName.set(setterName.getText(), binding.stateId);
    }
    return;
  }

  if (Node.isObjectBindingPattern(nameNode) && binding.kind === "object" && binding.objectSetterStateByProp) {
    for (const element of nameNode.getElements()) {
      const propertyName = element.getPropertyNameNode()?.getText() ?? element.getName();
      const stateId = binding.objectSetterStateByProp.get(propertyName);
      if (!stateId) {
        continue;
      }

      const collected = new Set<string>();
      collectIdentifiersFromBindingName(element.getNameNode(), collected);
      for (const localName of collected) {
        localSetterByName.set(localName, stateId);
      }
    }
  }
}

function getReturnExpressions(functionNode: FunctionLikeNode): Expression[] {
  if ((Node.isArrowFunction(functionNode) || Node.isFunctionExpression(functionNode)) && !Node.isBlock(functionNode.getBody())) {
    const bodyExpression = functionNode.getBody();
    return Node.isExpression(bodyExpression) ? [bodyExpression] : [];
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

  const expressions: Expression[] = [];
  for (const returnStatement of body.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    if (!isInFunctionOwnScope(returnStatement, functionNode)) {
      continue;
    }
    const expression = returnStatement.getExpression();
    if (expression) {
      expressions.push(expression);
    }
  }

  return expressions;
}

function resolveHookWriteBindingFromReturnExpression(
  returnExpression: Expression,
  index: SymbolIndex,
  cache: Map<string, HookWriteBinding | null>,
  resolvingKeys: Set<string>,
  localValueBindings: Map<string, HookWriteBinding>,
  localSetterByName: Map<string, string>,
): HookWriteBinding | undefined {
  if (Node.isCallExpression(returnExpression)) {
    return resolveHookWriteBindingFromCallExpression(returnExpression, index, cache, resolvingKeys);
  }

  if (Node.isIdentifier(returnExpression)) {
    return localValueBindings.get(returnExpression.getText());
  }

  if (!Node.isObjectLiteralExpression(returnExpression)) {
    return undefined;
  }

  const objectSetterStateByProp = new Map<string, string>();
  for (const property of returnExpression.getProperties()) {
    if (Node.isShorthandPropertyAssignment(property)) {
      const propertyName = property.getName();
      const stateId = localSetterByName.get(propertyName);
      if (stateId) {
        objectSetterStateByProp.set(propertyName, stateId);
      }
      continue;
    }

    if (!Node.isPropertyAssignment(property)) {
      continue;
    }

    const initializer = property.getInitializer();
    if (!initializer || !Node.isIdentifier(initializer)) {
      continue;
    }

    const stateId = localSetterByName.get(initializer.getText());
    if (stateId) {
      objectSetterStateByProp.set(property.getName(), stateId);
    }
  }

  if (objectSetterStateByProp.size === 0) {
    return undefined;
  }

  return {
    kind: "object",
    objectSetterStateByProp,
  };
}

function bindSetterIdentifiersFromDeclaration(
  declaration: Node,
  binding: HookWriteBinding,
  setterSymbolToStateId: Map<string, string>,
): void {
  if (!Node.isVariableDeclaration(declaration)) {
    return;
  }

  const sourceFilePath = declaration.getSourceFile().getFilePath();
  const nameNode = declaration.getNameNode();

  if (binding.kind === "setter" && binding.stateId && Node.isIdentifier(nameNode)) {
    bindSetterIdentifier(nameNode, sourceFilePath, binding.stateId, setterSymbolToStateId);
    return;
  }

  if (binding.kind === "tuple" && binding.stateId && Node.isArrayBindingPattern(nameNode)) {
    const setterElement = nameNode.getElements()[1];
    if (!setterElement || !Node.isBindingElement(setterElement)) {
      return;
    }
    const setterNameNode = setterElement.getNameNode();
    if (Node.isIdentifier(setterNameNode)) {
      bindSetterIdentifier(setterNameNode, sourceFilePath, binding.stateId, setterSymbolToStateId);
    }
    return;
  }

  if (binding.kind === "object" && binding.objectSetterStateByProp && Node.isObjectBindingPattern(nameNode)) {
    for (const element of nameNode.getElements()) {
      const propertyName = element.getPropertyNameNode()?.getText() ?? element.getName();
      const stateId = binding.objectSetterStateByProp.get(propertyName);
      if (!stateId) {
        continue;
      }

      const collected = new Set<string>();
      collectIdentifiersFromBindingName(element.getNameNode(), collected);
      for (const localName of collected) {
        bindSetterIdentifierByName(localName, sourceFilePath, stateId, setterSymbolToStateId, element.getNameNode());
      }
    }
  }
}

function bindSetterIdentifier(
  identifier: Node,
  filePath: string,
  stateId: string,
  setterSymbolToStateId: Map<string, string>,
): void {
  if (!Node.isIdentifier(identifier)) {
    return;
  }

  const symbolKey = getSymbolKey(identifier);
  if (symbolKey) {
    setterSymbolToStateId.set(`sym|${symbolKey}`, stateId);
  }
  setterSymbolToStateId.set(getFallbackSetterKey(filePath, identifier.getText()), stateId);
}

function bindSetterIdentifierByName(
  localName: string,
  filePath: string,
  stateId: string,
  setterSymbolToStateId: Map<string, string>,
  fallbackNode: Node,
): void {
  setterSymbolToStateId.set(getFallbackSetterKey(filePath, localName), stateId);

  if (!Node.isIdentifier(fallbackNode)) {
    return;
  }

  const symbol = unwrapAliasedSymbol(fallbackNode.getSymbol());
  if (!symbol) {
    return;
  }

  for (const declaration of symbol.getDeclarations()) {
    if (!Node.isBindingElement(declaration)) {
      continue;
    }
    const nameNode = declaration.getNameNode();
    if (!Node.isIdentifier(nameNode) || nameNode.getText() !== localName) {
      continue;
    }
    const symbolKey = getSymbolKey(nameNode);
    if (symbolKey) {
      setterSymbolToStateId.set(`sym|${symbolKey}`, stateId);
    }
  }
}

function propagateSetterBindingsOneHop(
  sourceFiles: SourceFile[],
  baseSetterBindings: Map<string, string>,
): Map<string, string> {
  const propagated = new Map(baseSetterBindings);

  for (const sourceFile of sourceFiles) {
    for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const targetFunctions = resolveFunctionLikeNodesFromExpression(callExpression.getExpression());
      if (targetFunctions.length === 0) {
        continue;
      }

      const argumentsList = callExpression.getArguments();
      for (let index = 0; index < argumentsList.length; index += 1) {
        const argument = argumentsList[index];
        if (!Node.isIdentifier(argument)) {
          continue;
        }

        const stateId = resolveStateIdFromIdentifier(argument, baseSetterBindings);
        if (!stateId) {
          continue;
        }

        for (const targetFunction of targetFunctions) {
          const parameter = targetFunction.getParameters()[index];
          if (!parameter) {
            continue;
          }

          const parameterName = parameter.getNameNode();
          if (Node.isIdentifier(parameterName)) {
            bindSetterIdentifier(parameterName, targetFunction.getSourceFile().getFilePath(), stateId, propagated);
          }
        }
      }
    }

    for (const jsxAttribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
      const initializer = jsxAttribute.getInitializer();
      if (!initializer || !Node.isJsxExpression(initializer)) {
        continue;
      }

      const expression = initializer.getExpression();
      if (!expression || !Node.isIdentifier(expression)) {
        continue;
      }

      const stateId = resolveStateIdFromIdentifier(expression, baseSetterBindings);
      if (!stateId) {
        continue;
      }

      const tagNameNode = getJsxTagNameNode(jsxAttribute);
      if (!tagNameNode || !Node.isIdentifier(tagNameNode)) {
        continue;
      }

      const targetFunctions = resolveFunctionLikeNodesFromExpression(tagNameNode);
      if (targetFunctions.length === 0) {
        continue;
      }

      const propName = jsxAttribute.getNameNode().getText();

      for (const targetFunction of targetFunctions) {
        const propsParameter = targetFunction.getParameters()[0];
        if (!propsParameter) {
          continue;
        }

        const propsParameterNameNode = propsParameter.getNameNode();
        if (Node.isObjectBindingPattern(propsParameterNameNode)) {
          for (const element of propsParameterNameNode.getElements()) {
            const propertyName = element.getPropertyNameNode()?.getText() ?? element.getName();
            if (propertyName !== propName) {
              continue;
            }

            const collected = new Set<string>();
            collectIdentifiersFromBindingName(element.getNameNode(), collected);
            for (const localName of collected) {
              bindSetterIdentifierByName(
                localName,
                targetFunction.getSourceFile().getFilePath(),
                stateId,
                propagated,
                element.getNameNode(),
              );
            }
          }
          continue;
        }

        if (!Node.isIdentifier(propsParameterNameNode)) {
          continue;
        }

        for (const declaration of targetFunction.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
          if (!isInFunctionOwnScope(declaration, targetFunction)) {
            continue;
          }
          const declarationNameNode = declaration.getNameNode();
          if (!Node.isObjectBindingPattern(declarationNameNode)) {
            continue;
          }
          const initializerNode = declaration.getInitializer();
          if (!initializerNode || !Node.isIdentifier(initializerNode)) {
            continue;
          }
          if (initializerNode.getText() !== propsParameterNameNode.getText()) {
            continue;
          }

          for (const element of declarationNameNode.getElements()) {
            const propertyName = element.getPropertyNameNode()?.getText() ?? element.getName();
            if (propertyName !== propName) {
              continue;
            }
            const collected = new Set<string>();
            collectIdentifiersFromBindingName(element.getNameNode(), collected);
            for (const localName of collected) {
              bindSetterIdentifierByName(
                localName,
                targetFunction.getSourceFile().getFilePath(),
                stateId,
                propagated,
                element.getNameNode(),
              );
            }
          }
        }
      }
    }
  }

  return propagated;
}

function resolveStateIdFromIdentifier(identifier: Node, setterBindings: Map<string, string>): string | undefined {
  if (!Node.isIdentifier(identifier)) {
    return undefined;
  }

  const symbolKey = getSymbolKey(identifier);
  if (symbolKey) {
    const bySymbol = setterBindings.get(`sym|${symbolKey}`);
    if (bySymbol) {
      return bySymbol;
    }
  }

  return setterBindings.get(getFallbackSetterKey(identifier.getSourceFile().getFilePath(), identifier.getText()));
}

function resolveFunctionLikeNodesFromExpression(expression: Node): FunctionLikeNode[] {
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

function getFunctionLikeNodeKey(functionNode: FunctionLikeNode): string {
  return `${functionNode.getSourceFile().getFilePath()}:${functionNode.getStart()}`;
}

function isInFunctionOwnScope(node: Node, functionNode: FunctionLikeNode): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (isFunctionLikeNode(current)) {
      return current === functionNode;
    }
    current = current.getParent();
  }
  return false;
}

function getJsxTagNameNode(jsxAttribute: Node): Node | undefined {
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
    (factory.module === "jotai" && (factory.imported === "useAtomValue" || factory.imported === "useAtom"));

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
  const writeType = classifyWriteType(callExpression);
  return {
    type: writeType,
    phase: "runtime",
    stateId: targetStateId,
    actorType: "function",
    actorName: getContainingFunctionName(callExpression),
    filePath: callExpression.getSourceFile().getFilePath(),
    line: location.line,
    column: location.column,
    via: writeType === "initWrite" ? "initializeState:hook-setter-call" : "hook-setter-call",
  };
}

function extractSetterReferenceWriteEvents(
  sourceFile: SourceFile,
  setterSymbolToStateId: Map<string, string>,
): UsageEvent[] {
  const events: UsageEvent[] = [];

  for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (!isSetterReferenceWriteSite(identifier)) {
      continue;
    }

    const symbolKey = getSymbolKey(identifier);
    const targetStateId =
      (symbolKey ? setterSymbolToStateId.get(`sym|${symbolKey}`) : undefined) ??
      setterSymbolToStateId.get(getFallbackSetterKey(sourceFile.getFilePath(), identifier.getText()));
    if (!targetStateId) {
      continue;
    }

    const location = getLocation(identifier);
    const writeType = classifyWriteType(identifier);
    events.push({
      type: writeType,
      phase: "runtime",
      stateId: targetStateId,
      actorType: "function",
      actorName: getContainingFunctionName(identifier),
      filePath: sourceFile.getFilePath(),
      line: location.line,
      column: location.column,
      via: writeType === "initWrite" ? "initializeState:hook-setter-reference" : "hook-setter-reference",
    });
  }

  return events;
}

function classifyDirectMutationWrite(callExpression: CallExpression, index: SymbolIndex): UsageEvent | undefined {
  const mutationKind = resolveMutationKind(callExpression.getExpression());
  if (!mutationKind) {
    return undefined;
  }

  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) {
    return undefined;
  }

  const location = getLocation(callExpression);
  const writeType = classifyWriteType(callExpression);
  const via =
    mutationKind === "set"
      ? writeType === "initWrite"
        ? "initializeState:set"
        : "set-call"
      : writeType === "initWrite"
        ? "initializeState:reset"
        : "reset-call";

  return {
    type: writeType,
    phase: "runtime",
    stateId: targetState.id,
    actorType: "function",
    actorName: getContainingFunctionName(callExpression),
    filePath: callExpression.getSourceFile().getFilePath(),
    line: location.line,
    column: location.column,
    via,
  };
}

function extractRecoilCallbackEvents(
  sourceFile: SourceFile,
  importMap: ImportMap,
  index: SymbolIndex,
): UsageEvent[] {
  const events: UsageEvent[] = [];

  for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const factory = resolveCalledFactory(callExpression, importMap);
    if (!factory || factory.module !== "recoil" || factory.imported !== "useRecoilCallback") {
      continue;
    }

    const callbackFactory = resolveCallbackFactoryFunction(callExpression.getArguments()[0], importMap);
    if (!callbackFactory) {
      continue;
    }

    const bindings = parseRecoilCallbackBindings(callbackFactory);
    for (const innerCall of callbackFactory.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const readEvent = classifyRecoilCallbackRead(innerCall, bindings, index);
      if (readEvent) {
        events.push(readEvent);
      }

      const writeEvent = classifyRecoilCallbackWrite(innerCall, bindings, index);
      if (writeEvent) {
        events.push(writeEvent);
      }
    }
  }

  return events;
}

function extractJotaiAtomCallbackEvents(
  sourceFile: SourceFile,
  importMap: ImportMap,
  index: SymbolIndex,
): UsageEvent[] {
  const events: UsageEvent[] = [];

  for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const factory = resolveCalledFactory(callExpression, importMap);
    if (!factory || factory.module !== "jotai/utils" || factory.imported !== "useAtomCallback") {
      continue;
    }

    const callbackFactory = resolveCallbackFactoryFunction(callExpression.getArguments()[0], importMap);
    if (!callbackFactory) {
      continue;
    }

    const bindings = parseJotaiAtomCallbackBindings(callbackFactory);
    for (const innerCall of callbackFactory.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const readEvent = classifyJotaiAtomCallbackRead(innerCall, bindings, index);
      if (readEvent) {
        events.push(readEvent);
      }

      const writeEvent = classifyJotaiAtomCallbackWrite(innerCall, bindings, index);
      if (writeEvent) {
        events.push(writeEvent);
      }
    }
  }

  return events;
}

function parseRecoilCallbackBindings(callbackFactory: CallbackFactoryFunction): RecoilCallbackBindings {
  const bindings: RecoilCallbackBindings = {
    contextNames: new Set<string>(),
    snapshotNames: new Set<string>(),
    getNames: new Set<string>(),
    setNames: new Set<string>(),
    resetNames: new Set<string>(),
  };

  const contextParameter = callbackFactory.getParameters()[0];
  if (!contextParameter) {
    return bindings;
  }

  const parameterNameNode = contextParameter.getNameNode();
  if (Node.isIdentifier(parameterNameNode)) {
    bindings.contextNames.add(parameterNameNode.getText());
    return bindings;
  }

  if (!Node.isObjectBindingPattern(parameterNameNode)) {
    return bindings;
  }

  for (const element of parameterNameNode.getElements()) {
    const propertyName = element.getPropertyNameNode()?.getText() ?? element.getName();
    const localNameNode = element.getNameNode();

    if (propertyName === "set") {
      collectIdentifiersFromBindingName(localNameNode, bindings.setNames);
      continue;
    }

    if (propertyName === "reset") {
      collectIdentifiersFromBindingName(localNameNode, bindings.resetNames);
      continue;
    }

    if (propertyName !== "snapshot") {
      continue;
    }

    if (Node.isIdentifier(localNameNode)) {
      bindings.snapshotNames.add(localNameNode.getText());
      continue;
    }

    if (!Node.isObjectBindingPattern(localNameNode)) {
      continue;
    }

    for (const snapshotElement of localNameNode.getElements()) {
      const snapshotPropertyName = snapshotElement.getPropertyNameNode()?.getText() ?? snapshotElement.getName();
      if (!RECOIL_SNAPSHOT_READ_METHODS.has(snapshotPropertyName)) {
        continue;
      }
      collectIdentifiersFromBindingName(snapshotElement.getNameNode(), bindings.getNames);
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

function classifyRecoilCallbackRead(
  callExpression: CallExpression,
  bindings: RecoilCallbackBindings,
  index: SymbolIndex,
): UsageEvent | undefined {
  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) {
    return undefined;
  }

  const callee = callExpression.getExpression();
  let via: string | undefined;

  if (Node.isIdentifier(callee) && bindings.getNames.has(callee.getText())) {
    via = `recoil:snapshot.${callee.getText()}`;
  }

  if (Node.isPropertyAccessExpression(callee)) {
    const methodName = callee.getName();
    if (RECOIL_SNAPSHOT_READ_METHODS.has(methodName) && isRecoilSnapshotBase(callee.getExpression(), bindings)) {
      via = `recoil:snapshot.${methodName}`;
    }
  }

  if (!via) {
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
    via,
  };
}

function classifyRecoilCallbackWrite(
  callExpression: CallExpression,
  bindings: RecoilCallbackBindings,
  index: SymbolIndex,
): UsageEvent | undefined {
  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) {
    return undefined;
  }

  const mutationKind = resolveRecoilCallbackMutationKind(callExpression.getExpression(), bindings);
  if (!mutationKind) {
    return undefined;
  }

  const location = getLocation(callExpression);
  const writeType = classifyWriteType(callExpression);
  const via =
    mutationKind === "set"
      ? writeType === "initWrite"
        ? "initializeState:set"
        : "set-call"
      : writeType === "initWrite"
        ? "initializeState:reset"
        : "reset-call";

  return {
    type: writeType,
    phase: "runtime",
    stateId: targetState.id,
    actorType: "function",
    actorName: getContainingFunctionName(callExpression),
    filePath: callExpression.getSourceFile().getFilePath(),
    line: location.line,
    column: location.column,
    via,
  };
}

function classifyJotaiAtomCallbackRead(
  callExpression: CallExpression,
  bindings: JotaiAtomCallbackBindings,
  index: SymbolIndex,
): UsageEvent | undefined {
  const callee = callExpression.getExpression();
  if (!Node.isIdentifier(callee) || callee.getText() !== bindings.getName) {
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
    via: "jotai:useAtomCallback:get",
  };
}

function classifyJotaiAtomCallbackWrite(
  callExpression: CallExpression,
  bindings: JotaiAtomCallbackBindings,
  index: SymbolIndex,
): UsageEvent | undefined {
  const callee = callExpression.getExpression();
  if (!Node.isIdentifier(callee) || callee.getText() !== bindings.setName) {
    return undefined;
  }

  const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
  if (!targetState) {
    return undefined;
  }

  const location = getLocation(callExpression);
  const writeType = classifyWriteType(callExpression);
  return {
    type: writeType,
    phase: "runtime",
    stateId: targetState.id,
    actorType: "function",
    actorName: getContainingFunctionName(callExpression),
    filePath: callExpression.getSourceFile().getFilePath(),
    line: location.line,
    column: location.column,
    via: writeType === "initWrite" ? "initializeState:set" : "set-call",
  };
}

function resolveCallbackFactoryFunction(
  callbackArgument: Node | undefined,
  importMap: ImportMap,
): CallbackFactoryFunction | undefined {
  if (!callbackArgument) {
    return undefined;
  }

  const directFunction = resolveFunctionFromNode(callbackArgument);
  if (directFunction) {
    return directFunction;
  }

  if (!Node.isCallExpression(callbackArgument)) {
    return undefined;
  }

  const callbackFactory = resolveCalledFactory(callbackArgument, importMap);
  if (!callbackFactory || callbackFactory.module !== "react" || callbackFactory.imported !== "useCallback") {
    return undefined;
  }

  const wrappedFunction = callbackArgument.getArguments()[0];
  return resolveFunctionFromNode(wrappedFunction);
}

function resolveFunctionFromNode(node: Node | undefined): CallbackFactoryFunction | undefined {
  if (!node) {
    return undefined;
  }

  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node)) {
    return node;
  }

  if (!Node.isIdentifier(node)) {
    return undefined;
  }

  const symbol = unwrapAliasedSymbol(node.getSymbol());
  if (!symbol) {
    return undefined;
  }

  for (const declaration of symbol.getDeclarations()) {
    if (Node.isFunctionDeclaration(declaration)) {
      return declaration;
    }
    if (Node.isVariableDeclaration(declaration)) {
      const initializer = declaration.getInitializer();
      if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        return initializer;
      }
    }
  }

  return undefined;
}

function resolveRecoilCallbackMutationKind(
  callee: Expression,
  bindings: RecoilCallbackBindings,
): "set" | "reset" | undefined {
  if (Node.isIdentifier(callee)) {
    const calleeName = callee.getText();
    if (bindings.setNames.has(calleeName)) {
      return "set";
    }
    if (bindings.resetNames.has(calleeName)) {
      return "reset";
    }
    return undefined;
  }

  if (!Node.isPropertyAccessExpression(callee)) {
    return undefined;
  }

  const methodName = callee.getName();
  if (methodName !== "set" && methodName !== "reset") {
    return undefined;
  }

  const base = callee.getExpression();
  if (!Node.isIdentifier(base) || !bindings.contextNames.has(base.getText())) {
    return undefined;
  }

  return methodName;
}

function isRecoilSnapshotBase(baseExpression: Expression, bindings: RecoilCallbackBindings): boolean {
  if (Node.isIdentifier(baseExpression)) {
    return bindings.snapshotNames.has(baseExpression.getText());
  }

  if (Node.isPropertyAccessExpression(baseExpression)) {
    const propertyName = baseExpression.getName();
    const objectExpression = baseExpression.getExpression();
    return (
      propertyName === "snapshot" &&
      Node.isIdentifier(objectExpression) &&
      bindings.contextNames.has(objectExpression.getText())
    );
  }

  return false;
}

function resolveMutationKind(callee: Expression): "set" | "reset" | undefined {
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

function classifyWriteType(node: Node): WriteEventType {
  return isInitWriteContext(node) ? "initWrite" : "runtimeWrite";
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
  return getParameterNameOrDefault(functionNode.getParameters()[0], "get");
}

function getParameterNameOrDefault(
  parameter: ReturnType<CallbackFactoryFunction["getParameters"]>[number] | undefined,
  fallbackName: string,
): string {
  const nameNode = parameter?.getNameNode();
  if (nameNode && Node.isIdentifier(nameNode)) {
    return nameNode.getText();
  }
  return fallbackName;
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

function isSetterReferenceWriteSite(identifier: Node): boolean {
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

function getFunctionLikeName(node: FunctionLikeNode): string | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
    return node.getName() ?? undefined;
  }

  const variableDeclaration = node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (variableDeclaration) {
    return variableDeclaration.getName();
  }

  return undefined;
}

function isFunctionLikeNode(node: Node): node is FunctionLikeNode {
  return (
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node)
  );
}

function collectIdentifiersFromBindingName(bindingName: BindingName, target: Set<string>): void {
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
