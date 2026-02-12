import { useRecoilCallback, useRecoilValue } from "recoil";
import { counterState } from "./state";

export function Consumer() {
  const value = useRecoilValue(counterState);
  const clearCounter = useRecoilCallback(
    ({ reset: clear }) =>
      () => {
        clear(counterState);
      },
    [],
  );

  return <button onClick={clearCounter}>{value}</button>;
}
