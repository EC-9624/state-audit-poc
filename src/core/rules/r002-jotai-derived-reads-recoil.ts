import type { RuleContext } from "../analyzer";
import type { Violation } from "../types";

export function evaluateR002(context: RuleContext): Violation[] {
  const violations: Violation[] = [];

  for (const edge of context.dependencyEdges) {
    const fromState = context.stateById.get(edge.fromStateId);
    const toState = context.stateById.get(edge.toStateId);
    if (!fromState || !toState) {
      continue;
    }

    const isJotaiDerived =
      fromState.store === "jotai" && (fromState.kind === "derivedAtom" || fromState.kind === "atomWithDefault");
    if (!isJotaiDerived || toState.store !== "recoil") {
      continue;
    }

    violations.push({
      rule: "R002",
      state: fromState.name,
      file: edge.filePath,
      line: edge.line,
      message: "Jotai derived atom reads Recoil state via get(...)",
    });
  }

  return violations;
}
