import { useRecoilValue } from "recoil";
import { staleCounterState } from "./state";

export function Reader() {
  const value = useRecoilValue(staleCounterState);
  return <div>{value}</div>;
}
