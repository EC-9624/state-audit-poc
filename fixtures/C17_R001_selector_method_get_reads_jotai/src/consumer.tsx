import { useRecoilValue } from "recoil";
import { illegalSelectorMethod } from "./recoil-state";

export function Consumer() {
  const value = useRecoilValue(illegalSelectorMethod);
  return <div>{value}</div>;
}
