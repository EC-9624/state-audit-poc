import path from "node:path";
import { createAnalyzerContext } from "./analyzer";
import type { AnalyzerConfig, ImpactDependent, ImpactItem, ImpactReport, ImpactSite, StateSymbol, UsageEvent } from "./types";

export interface ImpactQuery {
  state?: string;
  file?: string;
  depth?: number;
}

export function runImpact(config: AnalyzerConfig, query: ImpactQuery): ImpactReport {
  const depth = Math.max(0, query.depth ?? 2);
  const context = createAnalyzerContext(config);

  const modeCount = Number(Boolean(query.state)) + Number(Boolean(query.file));
  if (modeCount !== 1) {
    throw new Error("Exactly one query mode is required: --state <name> or --file <path>");
  }

  const targets = query.state
    ? resolveStateTargets(context.states, query.state)
    : resolveFileTargets(context.states, config.rootDir, query.file as string);

  if (targets.length === 0) {
    throw new Error(query.state ? `State not found: ${query.state}` : `No states found in file: ${query.file}`);
  }

  const reverseDependencyMap = buildReverseDependencyMap(context.dependencyEdges);

  const items: ImpactItem[] = targets
    .map((state) => {
      const directReaders = collectImpactSites(context.usageEvents, state.id, "read");
      const runtimeWriters = collectImpactSites(context.usageEvents, state.id, "runtimeWrite");
      const initWriters = collectImpactSites(context.usageEvents, state.id, "initWrite");

      const transitiveDependents = collectTransitiveDependents(state.id, depth, reverseDependencyMap, context.stateById);

      return {
        state: state.name,
        store: state.store,
        kind: state.kind,
        definition: {
          file: state.filePath,
          line: state.line,
          column: state.column,
        },
        directReaders: sortSites(directReaders),
        runtimeWriters: sortSites(runtimeWriters),
        initWriters: sortSites(initWriters),
        transitiveDependents,
      };
    })
    .sort((left, right) => {
      if (left.definition.file !== right.definition.file) {
        return left.definition.file.localeCompare(right.definition.file);
      }
      if (left.definition.line !== right.definition.line) {
        return left.definition.line - right.definition.line;
      }
      return left.state.localeCompare(right.state);
    });

  return {
    ok: true,
    query: {
      mode: query.state ? "state" : "file",
      value: query.state ?? (query.file as string),
      depth,
    },
    items,
  };
}

function collectImpactSites(
  usageEvents: UsageEvent[],
  stateId: string,
  eventType: "read" | "runtimeWrite" | "initWrite",
): ImpactSite[] {
  return usageEvents
    .filter((event) => event.stateId === stateId && event.type === eventType)
    .map((event) => ({
      actor: event.actorName,
      file: event.filePath,
      line: event.line,
      column: event.column,
      via: event.via,
    }));
}

function resolveStateTargets(states: StateSymbol[], stateName: string): StateSymbol[] {
  return states.filter((state) => state.name === stateName);
}

function resolveFileTargets(states: StateSymbol[], rootDir: string, fileQuery: string): StateSymbol[] {
  const cwdResolved = path.resolve(process.cwd(), fileQuery);
  const rootResolved = path.resolve(rootDir, fileQuery);

  return states.filter((state) => {
    const statePath = path.resolve(state.filePath);
    return statePath === cwdResolved || statePath === rootResolved;
  });
}

function buildReverseDependencyMap(
  edges: Array<{ fromStateId: string; toStateId: string }>,
): Map<string, Set<string>> {
  const reverseMap = new Map<string, Set<string>>();

  for (const edge of edges) {
    const dependents = reverseMap.get(edge.toStateId) ?? new Set<string>();
    dependents.add(edge.fromStateId);
    reverseMap.set(edge.toStateId, dependents);
  }

  return reverseMap;
}

function collectTransitiveDependents(
  targetStateId: string,
  maxDepth: number,
  reverseDependencyMap: Map<string, Set<string>>,
  stateById: Map<string, StateSymbol>,
): ImpactDependent[] {
  if (maxDepth <= 0) {
    return [];
  }

  const visitedDepth = new Map<string, number>();
  const queue: Array<{ stateId: string; depth: number }> = [{ stateId: targetStateId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    const dependents = reverseDependencyMap.get(current.stateId);
    if (!dependents) {
      continue;
    }

    for (const dependentStateId of dependents) {
      const nextDepth = current.depth + 1;
      const existingDepth = visitedDepth.get(dependentStateId);
      if (existingDepth !== undefined && existingDepth <= nextDepth) {
        continue;
      }

      visitedDepth.set(dependentStateId, nextDepth);
      queue.push({ stateId: dependentStateId, depth: nextDepth });
    }
  }

  return [...visitedDepth.entries()]
    .map(([stateId, depth]) => {
      const state = stateById.get(stateId);
      if (!state) {
        return undefined;
      }
      return {
        state: state.name,
        file: state.filePath,
        line: state.line,
        column: state.column,
        depth,
      };
    })
    .filter((item): item is ImpactDependent => Boolean(item))
    .sort((left, right) => {
      if (left.depth !== right.depth) {
        return left.depth - right.depth;
      }
      if (left.file !== right.file) {
        return left.file.localeCompare(right.file);
      }
      if (left.line !== right.line) {
        return left.line - right.line;
      }
      return left.state.localeCompare(right.state);
    });
}

function sortSites(sites: ImpactSite[]): ImpactSite[] {
  return [...sites].sort((left, right) => {
    if (left.file !== right.file) {
      return left.file.localeCompare(right.file);
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    if (left.column !== right.column) {
      return left.column - right.column;
    }
    return left.actor.localeCompare(right.actor);
  });
}
