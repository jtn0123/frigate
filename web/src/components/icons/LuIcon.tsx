import { LuLayers } from "react-icons/lu";
import { cn } from "@/lib/utils";
import { phoneFixes } from "@/lib/fork/phone";
import { isLuIconName, useLuIcon } from "./luIcons";

// Frigate's config default for a camera group icon. It names no lucide icon,
// so every group saved without picking one rendered as an empty button.
const GENERIC_GROUP_ICON = "generic";

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

  // fork: show the camera-group icon the command palette uses instead
  if (phoneFixes && name === GENERIC_GROUP_ICON) {
    return <LuLayers className={className} size={size} />;
  }

  if (!isLuIconName(name)) {
    return null;
  }

  if (!Icon) {
    return <span aria-hidden className={cn("inline-block", className)} />;
  }

  return <Icon className={className} size={size} />;
}
