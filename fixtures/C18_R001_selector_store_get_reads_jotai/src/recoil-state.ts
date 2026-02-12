import { selector } from "recoil";
import { sharedCounterAtom } from "./jotai-state";
import { jotaiStore } from "./store";

export const illegalSelectorStoreGet = selector({
  key: "illegalSelectorStoreGet",
  get() {
    return jotaiStore.get(sharedCounterAtom);
  },
});
