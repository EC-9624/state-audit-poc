import { useRecoilValue, useResetRecoilState } from "recoil";
import { resettableCounterState } from "./state";

export function Consumer() {
  const value = useRecoilValue(resettableCounterState);
  const resetCounter = useResetRecoilState(resettableCounterState);

  return <button onClick={resetCounter}>{value}</button>;
}
