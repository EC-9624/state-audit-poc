import { useRecoilValue } from "recoil";
import { illegalSelectorStoreGet } from "./recoil-state";

export function Consumer() {
  const value = useRecoilValue(illegalSelectorStoreGet);
  return <div>{value}</div>;
}
