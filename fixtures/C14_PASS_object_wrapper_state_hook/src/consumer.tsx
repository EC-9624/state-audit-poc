import { useTitleState } from "./state";

export function Consumer() {
  const { title, setTitle } = useTitleState();

  return (
    <input
      value={title}
      onChange={(event) => {
        setTitle(event.target.value);
      }}
    />
  );
}
