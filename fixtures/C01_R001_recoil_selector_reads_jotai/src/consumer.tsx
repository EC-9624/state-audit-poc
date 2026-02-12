import { useRecoilValue } from "recoil";
import { illegalSelector } from "./recoil-state";

export function Consumer() {
  const value = useRecoilValue(illegalSelector);
  return <div>{value}</div>;
}
