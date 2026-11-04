import { RefObject, useCallback, useEffect, useState } from "react";
import { isMobile } from "react-device-detect";

export function useScrollLockout(ref: RefObject<HTMLElement | null>) {
  const [scrollLock, setScrollLock] = useState(false);

  const onScroll = useCallback(() => {
    if (!scrollLock) {
      setScrollLock(true);
    }
  }, [scrollLock, setScrollLock]);
  const onMouseMove = useCallback(() => {
    if (scrollLock) {
      setScrollLock(false);
    }
  }, [scrollLock, setScrollLock]);

  useEffect(() => {
    if (isMobile) {
      return;
    }

    if (!ref.current) {
      return;
    }

    const content = ref.current;
    content.addEventListener("scroll", onScroll);
    content.addEventListener("mousemove", onMouseMove);

    return () => {
      content.removeEventListener("scroll", onScroll);
      content.removeEventListener("mousemove", onMouseMove);
    };
  }, [ref, onScroll, onMouseMove]);

  return scrollLock;
}
