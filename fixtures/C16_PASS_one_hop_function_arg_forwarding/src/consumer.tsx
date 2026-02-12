import { useRecoilValue } from "recoil";
import { applyBody } from "./helpers";
import { bodyState, useSetBodyState } from "./state";

export function Consumer() {
  const body = useRecoilValue(bodyState);
  const setBody = useSetBodyState();

  return (
    <button
      onClick={() => {
        applyBody(setBody, "updated");
      }}
    >
      {body}
    </button>
  );
}
