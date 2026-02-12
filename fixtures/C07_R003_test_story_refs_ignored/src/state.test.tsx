import { useRecoilValue } from "recoil";
import { ignoredOnlyState } from "./state";

export function TestOnlyReader() {
  const value = useRecoilValue(ignoredOnlyState);
  return <div>{value}</div>;
}
