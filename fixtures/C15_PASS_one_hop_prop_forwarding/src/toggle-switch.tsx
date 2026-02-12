type Props = {
  onChecked: (value: boolean) => void;
};

export function ToggleSwitch({ onChecked }: Props) {
  return <button onClick={() => onChecked(true)}>Enable</button>;
}
