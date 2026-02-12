import { useRecoilValue } from "recoil";
import { legacyCounterState } from "./state";

export function Reader() {
  const value = useRecoilValue(legacyCounterState);
  return <div>{value}</div>;
}
