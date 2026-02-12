import { useRecoilValue } from "recoil";
import { counterState, useSetCounterState } from "./state";

export function Consumer() {
  const value = useRecoilValue(counterState);
  const setCounter = useSetCounterState();

  const onClick = () => {
    setCounter((current) => current + 1);
  };

  return <button onClick={onClick}>{value}</button>;
}
