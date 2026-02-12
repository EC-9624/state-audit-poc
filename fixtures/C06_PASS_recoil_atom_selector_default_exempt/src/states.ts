import { atom, selector, useRecoilValue } from "recoil";

export const sourceState = atom({
  key: "sourceState",
  default: 1,
});

export const sourceSelector = selector({
  key: "sourceSelector",
  get: ({ get }) => get(sourceState),
});

export const migratedState = atom({
  key: "migratedState",
  default: sourceSelector,
});

export function Demo() {
  const value = useRecoilValue(migratedState);
  return <div>{value}</div>;
}
