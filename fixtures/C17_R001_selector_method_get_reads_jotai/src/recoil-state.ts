import { selector } from "recoil";
import { sharedCounterAtom } from "./jotai-state";

export const illegalSelectorMethod = selector({
  key: "illegalSelectorMethod",
  get({ get }) {
    return get(sharedCounterAtom);
  },
});
