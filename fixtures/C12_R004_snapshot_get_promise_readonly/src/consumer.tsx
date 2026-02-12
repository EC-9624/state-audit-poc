import { useRecoilCallback } from "recoil";
import { callbackReadOnlyState } from "./state";

export function Consumer() {
  const check = useRecoilCallback(
    ({ snapshot: { getPromise } }) =>
      async () => {
        await getPromise(callbackReadOnlyState);
      },
    [],
  );

  return <button onClick={() => void check()}>Run</button>;
}
