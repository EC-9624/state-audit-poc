import { atom } from "jotai";
import { legacyCounterState } from "./recoil-state";

export const illegalDerivedAtom = atom((get) => get(legacyCounterState));
