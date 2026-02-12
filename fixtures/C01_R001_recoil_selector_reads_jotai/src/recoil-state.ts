import { selector } from "recoil";
import { sharedCounterAtom } from "./jotai-state";

export const illegalSelector = selector({
  key: "illegalSelector",
  get: ({ get }) => get(sharedCounterAtom),
});
