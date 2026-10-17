import { isIOS } from "react-device-detect";
import { parseTimeInput } from "@/lib/fork/time-input";

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
        const time = parseTimeInput(event.target.value, timestamp, isIOS);
        if (time !== null) onChange(time);
      }}
    />
  );
}
