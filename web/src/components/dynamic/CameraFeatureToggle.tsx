import { IconType } from "react-icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isDesktop } from "react-device-detect";
import { cn } from "@/lib/utils";
import ActivityIndicator from "../indicators/activity-indicator";
import { onActivate } from "@/utils/fork/a11y";

const variants = {
  primary: {
    active: "font-bold text-white bg-selected rounded-lg",
    inactive: "text-secondary-foreground bg-secondary rounded-lg",
    disabled:
      "text-secondary-foreground bg-secondary rounded-lg cursor-not-allowed opacity-50",
  },
  overlay: {
    active: "font-bold text-white bg-selected rounded-full",
    inactive:
      "text-primary rounded-full bg-gradient-to-br from-gray-400 to-gray-500 bg-gray-500",
    disabled:
      "bg-gradient-to-br from-gray-400 to-gray-500 bg-gray-500 rounded-full cursor-not-allowed opacity-50",
  },
};

type CameraFeatureToggleProps = {
  className?: string;
  variant?: "primary" | "overlay";
  isActive: boolean;
  Icon: IconType;
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
};

export default function CameraFeatureToggle({
  className = "",
  variant = "primary",
  isActive,
  Icon,
  title,
  onClick,
  disabled = false,
  loading = false,
}: Readonly<CameraFeatureToggleProps>) {
  const content = (
    <div
      onClick={disabled ? undefined : onClick}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={title}
      aria-pressed={isActive}
      aria-disabled={disabled || undefined}
      onKeyDown={onActivate(disabled ? undefined : onClick)}
      className={cn(
        "flex flex-col items-center justify-center",
        disabled
          ? variants[variant].disabled
          : variants[variant][isActive ? "active" : "inactive"],
        className,
      )}
    >
      {loading ? (
        <ActivityIndicator className="size-5 md:m-[6px]" />
      ) : (
        <Icon
          className={cn(
            "size-5 md:m-[6px]",
            disabled
              ? "text-gray-400"
              : isActive
                ? "text-white"
                : "text-secondary-foreground",
          )}
        />
      )}
    </div>
  );

  if (isDesktop) {
    return (
      <Tooltip>
        <TooltipTrigger asChild disabled={disabled}>
          {content}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{title}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return content;
}
