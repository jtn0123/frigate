import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { FaCog } from "react-icons/fa";
import { MdLabelOutline } from "react-icons/md";
import { onActivate } from "@/utils/fork/a11y";

type SubFilterIconProps = {
  className?: string;
  onClick?: () => void;
};

const SubFilterIcon = forwardRef<HTMLDivElement, SubFilterIconProps>(
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
        <FaCog className="absolute size-3 translate-x-3 translate-y-[62%]" />
        <MdLabelOutline className="size-5" />
      </div>
    );
  },
);

export default SubFilterIcon;
