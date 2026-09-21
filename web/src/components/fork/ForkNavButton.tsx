import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { isDesktop } from "react-device-detect";
import { TooltipPortal } from "@radix-ui/react-tooltip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ForkNavVariant = "sidebar" | "bottombar";

type ForkNavButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant: ForkNavVariant;
  large?: boolean;
  label: string;
  hint?: string;
  children: ReactNode;
};

/**
 * Icon button styled like the upstream sidebar / bottombar entries
 * (GeneralSettings and AccountSettings triggers) so fork additions blend in.
 */
const ForkNavButton = forwardRef<HTMLButtonElement, ForkNavButtonProps>(
  ({ variant, large, label, hint, className, children, ...props }, ref) => {
    const button = (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn(
          "relative flex flex-col items-center justify-center",
          variant === "sidebar"
            ? "cursor-pointer rounded-lg bg-secondary text-secondary-foreground hover:bg-muted"
            : "p-2 text-secondary-foreground",
          large && "size-12",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );

    if (!isDesktop) {
      return button;
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipPortal>
          <TooltipContent side="right">
            <p>{label}</p>
            {hint && (
              <p className="mt-1 max-w-56 text-xs text-muted-foreground">
                {hint}
              </p>
            )}
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>
    );
  },
);
ForkNavButton.displayName = "ForkNavButton";

export default ForkNavButton;
