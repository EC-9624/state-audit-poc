import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import {
  collectIdentifiersFromBindingName,
  getJsxTagNameNode,
  isInFunctionOwnScope,
  resolveFunctionLikeNodesFromExpression,
} from "../../shared/common";
import { bindSetterIdentifier, bindSetterIdentifierByName, resolveStateIdFromIdentifier } from "../../core/setter-bindings";

/**
 * One-hop setter propagation: function args + JSX props.
 * Adds setter bindings for parameters that receive a known setter.
 */
export function propagateSetterBindingsOneHop(
  sourceFiles: SourceFile[],
  baseSetterBindings: Map<string, string>,
): Map<string, string> {
  const propagated = new Map(baseSetterBindings);

  for (const sourceFile of sourceFiles) {
    // Function arg forwarding
    for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const targetFunctions = resolveFunctionLikeNodesFromExpression(callExpression.getExpression());
      if (targetFunctions.length === 0) continue;

      const argumentsList = callExpression.getArguments();
      for (let index = 0; index < argumentsList.length; index += 1) {
        const argument = argumentsList[index];
        if (!Node.isIdentifier(argument)) continue;

        const stateId = resolveStateIdFromIdentifier(argument, baseSetterBindings);
        if (!stateId) continue;

        for (const targetFunction of targetFunctions) {
          const parameter = targetFunction.getParameters()[index];
          if (!parameter) continue;
          const parameterName = parameter.getNameNode();
          if (Node.isIdentifier(parameterName)) {
            bindSetterIdentifier(parameterName, targetFunction.getSourceFile().getFilePath(), stateId, propagated);
          }
        }
      }
    }

    // JSX prop forwarding
    for (const jsxAttribute of sourceFile.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
      const initializer = jsxAttribute.getInitializer();
      if (!initializer || !Node.isJsxExpression(initializer)) continue;
      const expression = initializer.getExpression();
      if (!expression || !Node.isIdentifier(expression)) continue;

      const stateId = resolveStateIdFromIdentifier(expression, baseSetterBindings);
      if (!stateId) continue;

      const tagNameNode = getJsxTagNameNode(jsxAttribute);
      if (!tagNameNode || !Node.isIdentifier(tagNameNode)) continue;

      const targetFunctions = resolveFunctionLikeNodesFromExpression(tagNameNode);
      if (targetFunctions.length === 0) continue;

      const propName = jsxAttribute.getNameNode().getText();

      for (const targetFunction of targetFunctions) {
        const propsParameter = targetFunction.getParameters()[0];
        if (!propsParameter) continue;

        const propsParameterNameNode = propsParameter.getNameNode();
        if (Node.isObjectBindingPattern(propsParameterNameNode)) {
          for (const element of propsParameterNameNode.getElements()) {
            const propertyName = element.getPropertyNameNode()?.getText() ?? element.getName();
            if (propertyName !== propName) continue;
            const collected = new Set<string>();
            collectIdentifiersFromBindingName(element.getNameNode(), collected);
            for (const localName of collected) {
              bindSetterIdentifierByName(localName, targetFunction.getSourceFile().getFilePath(), stateId, propagated, element.getNameNode());
            }
          }
          continue;
        }

        if (!Node.isIdentifier(propsParameterNameNode)) continue;

        for (const declaration of targetFunction.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
          if (!isInFunctionOwnScope(declaration, targetFunction)) continue;
          const declarationNameNode = declaration.getNameNode();
          if (!Node.isObjectBindingPattern(declarationNameNode)) continue;
          const initializerNode = declaration.getInitializer();
          if (!initializerNode || !Node.isIdentifier(initializerNode)) continue;
          if (initializerNode.getText() !== propsParameterNameNode.getText()) continue;

          for (const element of declarationNameNode.getElements()) {
            const propertyName = element.getPropertyNameNode()?.getText() ?? element.getName();
            if (propertyName !== propName) continue;
            const collected = new Set<string>();
            collectIdentifiersFromBindingName(element.getNameNode(), collected);
            for (const localName of collected) {
              bindSetterIdentifierByName(localName, targetFunction.getSourceFile().getFilePath(), stateId, propagated, element.getNameNode());
            }
          }
        }
      }
    }
  }

  return propagated;
}
