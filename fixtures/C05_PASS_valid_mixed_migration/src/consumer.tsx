import { useAtom } from "jotai";
import { useRecoilState, useRecoilValue } from "recoil";
import { counterAtom } from "./jotai-state";
import { counterPlusOneSelector, counterState } from "./recoil-state";

export function Consumer() {
  const [count, setCount] = useRecoilState(counterState);
  const [modernCount, setModernCount] = useAtom(counterAtom);
  const plusOne = useRecoilValue(counterPlusOneSelector);

  const onClick = () => {
    setCount((value) => value + 1);
    setModernCount((value) => value + 1);
  };

  return <button onClick={onClick}>{count + modernCount + plusOne}</button>;
}
