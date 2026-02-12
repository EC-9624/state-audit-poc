import { atom, selector } from "recoil";

export const counterState = atom({
  key: "counterState",
  default: 0,
});

export const counterPlusOneSelector = selector({
  key: "counterPlusOneSelector",
  get: ({ get }) => get(counterState) + 1,
});
