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
        {/* fork (UI116): the plus sat inside the face outline, over the
            mouth; it is a badge in the corner instead */}
        <LuPlus className="absolute -bottom-0.5 -right-0.5 size-1/3 rounded-full bg-background" />
      </div>
    );
  },
);

export default AddFaceIcon;
