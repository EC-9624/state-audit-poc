import { Node, type SourceFile, type VariableDeclaration } from "ts-morph";
import { buildUsageEvents } from "./events";
import { isFileInScope } from "./config";
import { loadProject } from "./project";
import { evaluateR001 } from "./rules/r001-recoil-selector-reads-jotai";
import { evaluateR002 } from "./rules/r002-jotai-derived-reads-recoil";
import { evaluateR003 } from "./rules/r003-dead-recoil-state";
import { evaluateR004 } from "./rules/r004-stale-readonly-recoil-atom";
import { buildSymbolIndex } from "./symbols";
import type {
  AnalyzerConfig,
  AuditReport,
  DependencyEdge,
  ReferenceSite,
  StateSymbol,
  UsageEvent,
  Violation,
} from "./types";

export interface RuleContext {
  states: StateSymbol[];
  stateById: Map<string, StateSymbol>;
  usageEvents: UsageEvent[];
  dependencyEdges: DependencyEdge[];
  referencesByStateId: Map<string, ReferenceSite[]>;
}

export interface AnalyzerContext extends RuleContext {
  config: AnalyzerConfig;
  sourceFiles: SourceFile[];
  declarationByStateId: Map<string, VariableDeclaration>;
}

export function createAnalyzerContext(config: AnalyzerConfig): AnalyzerContext {
  const { sourceFiles } = loadProject(config);
  const symbolIndex = buildSymbolIndex(sourceFiles);
  const eventResult = buildUsageEvents(sourceFiles, symbolIndex, config);
  const referencesByStateId = buildReferenceIndex(config, symbolIndex.declarationByStateId);

  return {
    config,
    sourceFiles,
    states: symbolIndex.states,
    stateById: symbolIndex.stateById,
    declarationByStateId: symbolIndex.declarationByStateId,
    usageEvents: eventResult.usageEvents,
    dependencyEdges: eventResult.dependencyEdges,
    referencesByStateId,
  };
}

export function runAudit(config: AnalyzerConfig): AuditReport {
  const context = createAnalyzerContext(config);

  const violations = [
    ...evaluateR001(context),
    ...evaluateR002(context),
    ...evaluateR003(context),
    ...evaluateR004(context),
  ];

  const stableViolations = sortViolations(violations);

  return {
    ok: stableViolations.length === 0,
    summary: {
      violations: stableViolations.length,
    },
    violations: stableViolations,
  };
}

function buildReferenceIndex(
  config: AnalyzerConfig,
  declarationByStateId: Map<string, VariableDeclaration>,
): Map<string, ReferenceSite[]> {
  const referencesByStateId = new Map<string, ReferenceSite[]>();

  for (const [stateId, declaration] of declarationByStateId.entries()) {
    const definitionName = declaration.getNameNode();
    if (!Node.isIdentifier(definitionName)) {
      referencesByStateId.set(stateId, []);
      continue;
    }
    const definitionFilePath = definitionName.getSourceFile().getFilePath();
    const definitionStart = definitionName.getStart();
    const unique = new Map<string, ReferenceSite>();

    for (const referenceNode of definitionName.findReferencesAsNodes()) {
      const referenceFilePath = referenceNode.getSourceFile().getFilePath();
      if (!isFileInScope(config, referenceFilePath)) {
        continue;
      }

      if (referenceFilePath === definitionFilePath && referenceNode.getStart() === definitionStart) {
        continue;
      }

      const position = referenceNode.getSourceFile().getLineAndColumnAtPos(referenceNode.getStart());
      const site: ReferenceSite = {
        filePath: referenceFilePath,
        line: position.line,
        column: position.column,
      };

      const key = `${site.filePath}:${site.line}:${site.column}`;
      if (!unique.has(key)) {
        unique.set(key, site);
      }
    }

    referencesByStateId.set(
      stateId,
      [...unique.values()].sort((left, right) => {
        if (left.filePath !== right.filePath) {
          return left.filePath.localeCompare(right.filePath);
        }
        if (left.line !== right.line) {
          return left.line - right.line;
        }
        return left.column - right.column;
      }),
    );
  }

  return referencesByStateId;
}

function sortViolations(violations: Violation[]): Violation[] {
  return [...violations].sort((left, right) => {
    if (left.rule !== right.rule) {
      return left.rule.localeCompare(right.rule);
    }
    if (left.file !== right.file) {
      return left.file.localeCompare(right.file);
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    if (left.state !== right.state) {
      return left.state.localeCompare(right.state);
    }
    return left.message.localeCompare(right.message);
  });
}
