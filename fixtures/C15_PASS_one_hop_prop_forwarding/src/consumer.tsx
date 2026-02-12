import { useToggleState } from "./state";
import { ToggleSwitch } from "./toggle-switch";

export function Consumer() {
  const [enabled, setEnabled] = useToggleState();

  return (
    <div>
      <ToggleSwitch onChecked={setEnabled} />
      <span>{enabled ? "on" : "off"}</span>
    </div>
  );
}
