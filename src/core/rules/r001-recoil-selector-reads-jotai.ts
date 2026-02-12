import type { RuleContext } from "../analyzer";
import type { Violation } from "../types";

export function evaluateR001(context: RuleContext): Violation[] {
  const violations: Violation[] = [];

  for (const edge of context.dependencyEdges) {
    const fromState = context.stateById.get(edge.fromStateId);
    const toState = context.stateById.get(edge.toStateId);
    if (!fromState || !toState) {
      continue;
    }

    const isRecoilSelector =
      fromState.store === "recoil" && (fromState.kind === "selector" || fromState.kind === "selectorFamily");
    if (!isRecoilSelector || toState.store !== "jotai") {
      continue;
    }

    violations.push({
      rule: "R001",
      state: fromState.name,
      file: edge.filePath,
      line: edge.line,
      message: "Recoil selector reads Jotai state via get(...)",
    });
  }

  return violations;
}
