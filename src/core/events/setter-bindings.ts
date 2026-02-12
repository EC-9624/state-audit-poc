import { Node, SyntaxKind, type CallExpression, type Expression, type SourceFile } from "ts-morph";
import { resolveCalledFactory, resolveStateFromExpression, type SymbolIndex } from "../symbols";
import {
  JOTAI_SETTER_FACTORIES,
  JOTAI_TUPLE_FACTORIES,
  RECOIL_SETTER_FACTORIES,
  RECOIL_TUPLE_FACTORIES,
  collectIdentifiersFromBindingName,
  getFallbackSetterKey,
  getFunctionLikeNodeKey,
  getJsxTagNameNode,
  getSymbolKey,
  isInFunctionOwnScope,
  resolveFunctionLikeNodesFromExpression,
  type FunctionLikeNode,
  unwrapAliasedSymbol,
} from "./common";

type HookWriteBindingKind = "setter" | "tuple" | "object";

interface HookWriteBinding {
  kind: HookWriteBindingKind;
  stateId?: string;
  objectSetterStateByProp?: Map<string, string>;
}

export function buildSetterBindings(sourceFiles: SourceFile[], index: SymbolIndex): Map<string, string> {
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

      bindSetterIdentifiersFromDeclaration(declaration, hookBinding, setterSymbolToStateId);
    }
  }

  return setterSymbolToStateId;
}

export function buildJotaiStoreSymbolKeys(sourceFiles: SourceFile[], index: SymbolIndex): Set<string> {
  const keys = new Set<string>();

  for (const sourceFile of sourceFiles) {
    const importMap = index.importMapByFilePath.get(sourceFile.getFilePath());
    if (!importMap) {
      continue;
    }

    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const initCall = declaration.getInitializerIfKind(SyntaxKind.CallExpression);
      if (!initCall) {
        continue;
      }

      const factory = resolveCalledFactory(initCall, importMap);
      if (!factory || factory.module !== "jotai" || factory.imported !== "createStore") {
        continue;
      }

      const nameNode = declaration.getNameNode();
      if (!Node.isIdentifier(nameNode)) {
        continue;
      }

      const symbolKey = getSymbolKey(nameNode);
      if (symbolKey) {
        keys.add(`sym|${symbolKey}`);
      }
      keys.add(getFallbackSetterKey(sourceFile.getFilePath(), nameNode.getText()));
    }
  }

  return keys;
}

export function propagateSetterBindingsOneHop(
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

export function resolveStateIdFromIdentifier(identifier: Node, setterBindings: Map<string, string>): string | undefined {
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

export function isJotaiStoreGetCall(callExpression: CallExpression, jotaiStoreSymbolKeys: Set<string>): boolean {
  const callee = callExpression.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "get") {
    return false;
  }

  const base = callee.getExpression();
  if (!Node.isIdentifier(base)) {
    return false;
  }

  return isKnownJotaiStoreIdentifier(base, jotaiStoreSymbolKeys);
}

export function isJotaiStoreSetCall(callExpression: CallExpression, jotaiStoreSymbolKeys: Set<string>): boolean {
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

  if (factory.module === "recoil" && RECOIL_SETTER_FACTORIES.has(factory.imported)) {
    const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
    if (!targetState) {
      return undefined;
    }
    return {
      kind: "setter",
      stateId: targetState.id,
    };
  }

  if (factory.module === "jotai" && JOTAI_SETTER_FACTORIES.has(factory.imported)) {
    const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
    if (!targetState) {
      return undefined;
    }
    return {
      kind: "setter",
      stateId: targetState.id,
    };
  }

  if (factory.module === "recoil" && RECOIL_TUPLE_FACTORIES.has(factory.imported)) {
    const targetState = resolveStateFromExpression(callExpression.getArguments()[0], index);
    if (!targetState) {
      return undefined;
    }
    return {
      kind: "tuple",
      stateId: targetState.id,
    };
  }

  if (factory.module === "jotai" && JOTAI_TUPLE_FACTORIES.has(factory.imported)) {
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
