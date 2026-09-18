import { useEffect } from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";
import { registerToaster } from "@/api/fork/read-error-toast";
import { phoneTouch } from "@/lib/fork/phone";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  useEffect(registerToaster, []);

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // fork: sonner's default is bottom-right, which on a phone is on top of
      // the bottom bar; a page's own position still wins
      position={phoneTouch ? "top-center" : undefined}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          // error toasts sit on bg-danger, where muted gray text read at ~1.4:1
          description:
            "group-[.toast]:text-muted-foreground group-data-[type=error]:!text-foreground/90",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          closeButton:
            "group-[.toast]:bg-secondary group-[.toast]:text-primary group-[.toast]:border-primary group-[.toast]:border-[1px]",
          success:
            "group toast group-[.toaster]:bg-success group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          error:
            "group toast group-[.toaster]:bg-danger group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
