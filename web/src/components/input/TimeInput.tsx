import { isIOS } from "react-device-detect";

type TimeInputProps = {
  id: string;
  label: string;
  value: string;
  timestamp: number;
  onChange: (timestamp: number) => void;
};

export function TimeInput({
  id,
  label,
  value,
  timestamp,
  onChange,
}: Readonly<TimeInputProps>) {
  return (
    <input
      className="mx-4 w-full border border-input bg-background p-1 text-secondary-foreground hover:bg-accent hover:text-accent-foreground dark:[color-scheme:dark]"
      id={id}
      aria-label={label}
      type="time"
      value={value}
      step={isIOS ? "60" : "1"}
      onChange={(event) => {
        const clock = event.target.value;
        const [hour, minute, second] = isIOS
          ? [...clock.split(":"), "00"]
          : clock.split(":");
        const time = new Date(timestamp * 1000);
        time.setHours(
          Number.parseInt(hour),
          Number.parseInt(minute),
          Number.parseInt(second ?? "0"),
          0,
        );
        onChange(time.getTime() / 1000);
      }}
    />
  );
}
