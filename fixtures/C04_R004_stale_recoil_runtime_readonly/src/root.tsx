import { RecoilRoot } from "recoil";
import { Reader } from "./reader";
import { legacyCounterState } from "./state";

export function Root() {
  return (
    <RecoilRoot initializeState={({ set }) => set(legacyCounterState, 10)}>
      <Reader />
    </RecoilRoot>
  );
}
