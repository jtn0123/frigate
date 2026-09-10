import { forwardRef } from "react";
import { LuPlus, LuScanFace } from "react-icons/lu";
import { cn } from "@/lib/utils";
import { onActivate } from "@/utils/fork/a11y";

type AddFaceIconProps = {
  className?: string;
  onClick?: () => void;
};

const AddFaceIcon = forwardRef<HTMLDivElement, AddFaceIconProps>(
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
        <LuScanFace className="size-full" />
        <LuPlus className="absolute size-4 translate-x-3 translate-y-3" />
      </div>
    );
  },
);

export default AddFaceIcon;
