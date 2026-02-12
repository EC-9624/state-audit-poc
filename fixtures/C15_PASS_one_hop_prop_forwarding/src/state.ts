import { atom, useRecoilState } from "recoil";

export const toggleState = atom({
  key: "toggleState",
  default: false,
});

export const useToggleState = () => useRecoilState(toggleState);
