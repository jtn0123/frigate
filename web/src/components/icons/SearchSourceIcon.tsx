import { forwardRef } from "react";
import { cn } from "@/lib/utils";
import { FaImage } from "react-icons/fa";
import { LuText } from "react-icons/lu";
import { onActivate } from "@/utils/fork/a11y";

type SearchSourceIconProps = {
  className?: string;
  onClick?: () => void;
};

const SearchSourceIcon = forwardRef<HTMLDivElement, SearchSourceIconProps>(
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
        <LuText className="absolute size-3 translate-x-3 translate-y-3/4" />
        <FaImage className="size-5" />
      </div>
    );
  },
);

export default SearchSourceIcon;
