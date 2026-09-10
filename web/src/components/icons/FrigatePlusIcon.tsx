import { forwardRef } from "react";
import { LuPlus } from "react-icons/lu";
import Logo from "../Logo";
import { cn } from "@/lib/utils";
import { onActivate } from "@/utils/fork/a11y";

type FrigatePlusIconProps = {
  className?: string;
  onClick?: () => void;
};

const FrigatePlusIcon = forwardRef<HTMLDivElement, FrigatePlusIconProps>(
  ({ className, onClick }, ref) => {
    return (
      <div
        ref={ref}
        className={cn("relative flex items-center", className)}
        onClick={onClick}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={onActivate(onClick)}
      >
        <Logo className="size-full" />
        <LuPlus className="absolute size-2 translate-x-3 translate-y-3/4" />
      </div>
    );
  },
);

export default FrigatePlusIcon;
