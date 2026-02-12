import { useRecoilValue } from "recoil";
import { ignoredOnlyState } from "./state";

export function StoryOnlyReader() {
  const value = useRecoilValue(ignoredOnlyState);
  return <div>{value}</div>;
}
