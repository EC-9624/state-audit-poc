import { atom, useSetRecoilState } from "recoil";

export const counterState = atom({
  key: "counterState",
  default: 0,
});

export const useSetCounterState = () => useSetRecoilState(counterState);
