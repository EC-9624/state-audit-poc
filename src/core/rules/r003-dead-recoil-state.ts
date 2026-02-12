import type { RuleContext } from "../analyzer";
import type { Violation } from "../types";

export function evaluateR003(context: RuleContext): Violation[] {
  const violations: Violation[] = [];

  for (const state of context.states) {
    if (state.store !== "recoil") {
      continue;
    }

    if (state.kind !== "atom" && state.kind !== "selector") {
      continue;
    }

    if (!state.exported) {
      continue;
    }

    const references = context.referencesByStateId.get(state.id) ?? [];
    if (references.length > 0) {
      continue;
    }

    violations.push({
      rule: "R003",
      state: state.name,
      file: state.filePath,
      line: state.line,
      message: "Exported Recoil state has zero non-ignored references",
    });
  }

  return violations;
}
