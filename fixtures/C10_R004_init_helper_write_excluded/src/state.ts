import { atom } from "recoil";

export const staleCounterState = atom({
  key: "staleCounterState",
  default: 0,
});
