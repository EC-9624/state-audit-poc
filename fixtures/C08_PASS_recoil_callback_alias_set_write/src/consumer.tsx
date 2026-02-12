import { useRecoilCallback, useRecoilValue } from "recoil";
import { counterState } from "./state";

export function Consumer() {
  const value = useRecoilValue(counterState);
  const increment = useRecoilCallback(
    ({ set: apply }) =>
      () => {
        apply(counterState, (current: number) => current + 1);
      },
    [],
  );

  return <button onClick={increment}>{value}</button>;
}
