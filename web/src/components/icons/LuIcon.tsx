import { cn } from "@/lib/utils";
import { isLuIconName, useLuIcon } from "./luIcons";

type LuIconProps = {
  name?: string;
  className?: string;
  size?: number;
};

/**
 * Renders a user-selected icon from react-icons/lu without pulling the whole
 * set into the eager bundle. Renders nothing for unknown names and an empty
 * box of the same size while the set is still loading so layout stays put.
 */
export function LuIcon({ name, className, size }: Readonly<LuIconProps>) {
  const Icon = useLuIcon(name);

  if (!isLuIconName(name)) {
    return null;
  }

  if (!Icon) {
    return <span aria-hidden className={cn("inline-block", className)} />;
  }

  return <Icon className={className} size={size} />;
}
