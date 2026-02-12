import {
  Node,
  SyntaxKind,
  type CallExpression,
  type ImportDeclaration,
  type SourceFile,
  type Symbol as MorphSymbol,
  type VariableDeclaration,
} from "ts-morph";
import type { StateKind, StateSymbol, Store } from "./types";

interface ImportEntryNamed {
  type: "named";
  module: string;
  imported: string;
}

interface ImportEntryNamespace {
  type: "namespace";
  module: string;
}

type ImportEntry = ImportEntryNamed | ImportEntryNamespace;
export type ImportMap = Map<string, ImportEntry>;

interface StateInternal {
  state: StateSymbol;
  declaration: VariableDeclaration;
  initCall: CallExpression;
}

export interface SymbolIndex {
  states: StateSymbol[];
  stateById: Map<string, StateSymbol>;
  declarationByStateId: Map<string, VariableDeclaration>;
  initCallByStateId: Map<string, CallExpression>;
  stateByDeclarationKey: Map<string, StateSymbol>;
  importMapByFilePath: Map<string, ImportMap>;
}

export function buildSymbolIndex(sourceFiles: SourceFile[]): SymbolIndex {
  const importMapByFilePath = new Map<string, ImportMap>();
  const internals: StateInternal[] = [];
  const stateByDeclarationKey = new Map<string, StateSymbol>();

  for (const sourceFile of sourceFiles) {
    const importMap = buildImportMap(sourceFile.getImportDeclarations());
    importMapByFilePath.set(sourceFile.getFilePath(), importMap);

    for (const declaration of sourceFile.getVariableDeclarations()) {
      const initCall = declaration.getInitializerIfKind(SyntaxKind.CallExpression);
      if (!initCall) {
        continue;
      }

      const factory = resolveCalledFactory(initCall, importMap);
      if (!factory) {
        continue;
      }

      const classification = classifyStateFactory(factory.module, factory.imported, initCall);
      if (!classification) {
        continue;
      }

      const name = declaration.getName();
      const nameNode = declaration.getNameNode();
      const source = declaration.getSourceFile();
      const position = source.getLineAndColumnAtPos(nameNode.getStart());
      const state: StateSymbol = {
        id: createStateId(source.getFilePath(), name),
        name,
        store: classification.store,
        kind: classification.kind,
        filePath: source.getFilePath(),
        line: position.line,
        column: position.column,
        exported: declaration.getVariableStatement()?.isExported() ?? false,
        isRecoilPlainAtom: classification.store === "recoil" && classification.kind === "atom",
      };

      const internal: StateInternal = {
        state,
        declaration,
        initCall,
      };
      internals.push(internal);
      stateByDeclarationKey.set(getDeclarationKey(declaration), state);
    }
  }

  const temporaryIndex: SymbolIndex = {
    states: internals.map((internal) => internal.state),
    stateById: new Map(internals.map((internal) => [internal.state.id, internal.state])),
    declarationByStateId: new Map(internals.map((internal) => [internal.state.id, internal.declaration])),
    initCallByStateId: new Map(internals.map((internal) => [internal.state.id, internal.initCall])),
    stateByDeclarationKey,
    importMapByFilePath,
  };

  for (const internal of internals) {
    if (internal.state.store !== "recoil" || internal.state.kind !== "atom") {
      continue;
    }
    internal.state.isRecoilPlainAtom = !hasSelectorDefault(internal.initCall, temporaryIndex);
  }

  temporaryIndex.states.sort((left, right) => {
    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.name.localeCompare(right.name);
  });

  return temporaryIndex;
}

export function resolveStateFromExpression(node: Node | undefined, index: SymbolIndex): StateSymbol | undefined {
  if (!node) {
    return undefined;
  }

  const symbol = unwrapAliasedSymbol(node.getSymbol());
  if (!symbol) {
    return undefined;
  }

  for (const declaration of symbol.getDeclarations()) {
    if (Node.isVariableDeclaration(declaration)) {
      const match = index.stateByDeclarationKey.get(getDeclarationKey(declaration));
      if (match) {
        return match;
      }
      continue;
    }

    const maybeVariable = declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    if (maybeVariable) {
      const match = index.stateByDeclarationKey.get(getDeclarationKey(maybeVariable));
      if (match) {
        return match;
      }
    }
  }

  return undefined;
}

export function resolveCalledFactory(
  callExpression: CallExpression,
  importMap: ImportMap,
): { module: string; imported: string } | undefined {
  const expression = callExpression.getExpression();

  if (Node.isIdentifier(expression)) {
    const entry = importMap.get(expression.getText());
    if (!entry || entry.type !== "named") {
      return undefined;
    }
    return {
      module: entry.module,
      imported: entry.imported,
    };
  }

  if (Node.isPropertyAccessExpression(expression)) {
    const base = expression.getExpression();
    if (!Node.isIdentifier(base)) {
      return undefined;
    }
    const namespaceEntry = importMap.get(base.getText());
    if (!namespaceEntry || namespaceEntry.type !== "namespace") {
      return undefined;
    }
    return {
      module: namespaceEntry.module,
      imported: expression.getName(),
    };
  }

  return undefined;
}

function buildImportMap(importDeclarations: ImportDeclaration[]): ImportMap {
  const map: ImportMap = new Map();
  for (const declaration of importDeclarations) {
    const moduleSpecifier = declaration.getModuleSpecifierValue();

    for (const namedImport of declaration.getNamedImports()) {
      const localName = namedImport.getAliasNode()?.getText() ?? namedImport.getName();
      const importedName = namedImport.getName();
      map.set(localName, {
        type: "named",
        module: moduleSpecifier,
        imported: importedName,
      });
    }

    const namespaceImport = declaration.getNamespaceImport();
    if (namespaceImport) {
      map.set(namespaceImport.getText(), {
        type: "namespace",
        module: moduleSpecifier,
      });
    }
  }
  return map;
}

function classifyStateFactory(
  moduleSpecifier: string,
  importedName: string,
  callExpression: CallExpression,
): { store: Store; kind: StateKind } | undefined {
  if (moduleSpecifier === "recoil") {
    if (
      importedName === "atom" ||
      importedName === "selector" ||
      importedName === "atomFamily" ||
      importedName === "selectorFamily"
    ) {
      return {
        store: "recoil",
        kind: importedName,
      };
    }
    return undefined;
  }

  if (moduleSpecifier === "jotai") {
    if (importedName === "atom") {
      const firstArg = callExpression.getArguments()[0];
      if (firstArg && isFunctionLikeExpression(firstArg)) {
        return {
          store: "jotai",
          kind: "derivedAtom",
        };
      }
      return {
        store: "jotai",
        kind: "atom",
      };
    }
    return undefined;
  }

  if (moduleSpecifier === "jotai/utils") {
    if (importedName === "atomFamily") {
      return {
        store: "jotai",
        kind: "atomFamily",
      };
    }
    if (importedName === "atomWithDefault") {
      return {
        store: "jotai",
        kind: "atomWithDefault",
      };
    }
    return undefined;
  }

  return undefined;
}

function hasSelectorDefault(atomCall: CallExpression, index: SymbolIndex): boolean {
  const optionsArg = atomCall.getArguments()[0];
  if (!optionsArg || !Node.isObjectLiteralExpression(optionsArg)) {
    return false;
  }

  const defaultProperty = optionsArg
    .getProperties()
    .find((property) => Node.isPropertyAssignment(property) && property.getName() === "default");

  if (!defaultProperty || !Node.isPropertyAssignment(defaultProperty)) {
    return false;
  }

  const initializer = defaultProperty.getInitializer();
  if (!initializer) {
    return false;
  }

  if (Node.isCallExpression(initializer)) {
    const importMap = index.importMapByFilePath.get(initializer.getSourceFile().getFilePath());
    if (importMap) {
      const factory = resolveCalledFactory(initializer, importMap);
      if (
        factory &&
        factory.module === "recoil" &&
        (factory.imported === "selector" || factory.imported === "selectorFamily")
      ) {
        return true;
      }
    }
  }

  const referencedState = resolveStateFromExpression(initializer, index);
  if (!referencedState) {
    return false;
  }

  return (
    referencedState.store === "recoil" &&
    (referencedState.kind === "selector" || referencedState.kind === "selectorFamily")
  );
}

function createStateId(filePath: string, stateName: string): string {
  return `${filePath}::${stateName}`;
}

function getDeclarationKey(declaration: VariableDeclaration): string {
  return `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}`;
}

function unwrapAliasedSymbol(symbol: MorphSymbol | undefined): MorphSymbol | undefined {
  if (!symbol) {
    return undefined;
  }
  return symbol.getAliasedSymbol() ?? symbol;
}

function isFunctionLikeExpression(expression: Node): boolean {
  return Node.isArrowFunction(expression) || Node.isFunctionExpression(expression);
}
