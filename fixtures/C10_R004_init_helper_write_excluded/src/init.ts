import type { MutableSnapshot } from "recoil";
import { staleCounterState } from "./state";

export function initializeCounter(set: MutableSnapshot["set"]): void {
  set(staleCounterState, 1);
}
