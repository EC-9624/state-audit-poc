import type { RuleContext } from "../analyzer";
import type { Violation } from "../types";

export function evaluateR004(context: RuleContext): Violation[] {
  const violations: Violation[] = [];

  for (const state of context.states) {
    if (state.store !== "recoil" || state.kind !== "atom" || !state.isRecoilPlainAtom) {
      continue;
    }

    let runtimeReads = 0;
    let runtimeWrites = 0;
    let initWrites = 0;

    for (const event of context.usageEvents) {
      if (event.stateId !== state.id) {
        continue;
      }

      if (event.type === "read" && event.phase === "runtime") {
        runtimeReads += 1;
      }

      if (event.type === "runtimeWrite") {
        runtimeWrites += 1;
      }

      if (event.type === "initWrite") {
        initWrites += 1;
      }
    }

    if (runtimeReads > 0 && runtimeWrites === 0) {
      violations.push({
        rule: "R004",
        state: state.name,
        file: state.filePath,
        line: state.line,
        message: "Recoil atom is read at runtime but has no runtime writes",
        metrics: {
          runtimeReads,
          runtimeWrites,
          initWrites,
        },
      });
    }
  }

  return violations;
}
