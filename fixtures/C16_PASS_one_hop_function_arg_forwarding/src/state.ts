import { atom, useSetRecoilState } from "recoil";

export const bodyState = atom({
  key: "bodyState",
  default: "",
});

export const useSetBodyState = () => useSetRecoilState(bodyState);
