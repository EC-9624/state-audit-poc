type Setter = (value: string) => void;

export function applyBody(setBody: Setter, value: string) {
  setBody(value);
}
