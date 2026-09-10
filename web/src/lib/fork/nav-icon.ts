import { cn } from "@/lib/utils";

/** Icon sizing that matches the upstream sidebar / bottombar entries. */
export function forkNavIconClass(large?: boolean) {
  return cn("md:m-[6px]", large ? "size-6" : "size-5");
}
