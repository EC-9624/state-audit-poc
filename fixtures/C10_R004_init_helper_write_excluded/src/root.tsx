import { RecoilRoot } from "recoil";
import { initializeCounter } from "./init";
import { Reader } from "./reader";

export function Root() {
  return (
    <RecoilRoot initializeState={({ set }) => initializeCounter(set)}>
      <Reader />
    </RecoilRoot>
  );
}
