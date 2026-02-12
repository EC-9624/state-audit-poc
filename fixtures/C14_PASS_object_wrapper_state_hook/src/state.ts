import { atom, useRecoilState } from "recoil";

export const titleState = atom({
  key: "titleState",
  default: "",
});

export function useTitleState() {
  const [title, setTitle] = useRecoilState(titleState);
  return { title, setTitle };
}
