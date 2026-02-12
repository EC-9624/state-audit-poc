import { atom } from "recoil";

export const resettableCounterState = atom({
  key: "resettableCounterState",
  default: 3,
});
