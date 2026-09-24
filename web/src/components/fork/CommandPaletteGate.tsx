/** Keep keyboard shortcuts in the shell and load palette search on demand. */
import { lazy, Suspense, useEffect, useState } from "react";
import { isForkEnabled } from "@/fork/flags";
import {
  useCommandPaletteOpen,
  useCommandPaletteShortcuts,
} from "@/hooks/fork/use-command-palette";

const CommandPalette = lazy(() => import("./CommandPalette"));

export default function CommandPaletteGate() {
  const [open] = useCommandPaletteOpen();
  const [loaded, setLoaded] = useState(false);
  useCommandPaletteShortcuts();
  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);
  if (!isForkEnabled("commandPalette") || (!open && !loaded)) return null;
  return (
    <Suspense fallback={null}>
      <CommandPalette />
    </Suspense>
  );
}
