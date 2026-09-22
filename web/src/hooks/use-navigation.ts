import { ENV } from "@/env";
import { FrigateConfig } from "@/types/frigateConfig";
import { NavData } from "@/types/navigation";
import { useMemo } from "react";
import { isDesktop } from "react-device-detect";
// fork (UI132): the rail draws from one icon family. Five families met in a
// 52px column, so stroke weight and optical size changed from row to row.
import {
  LuConstruction,
  LuFilm,
  LuGalleryThumbnails,
  LuMessageCircle,
  LuSearch,
  LuShapes,
  LuUsersRound,
  LuVideo,
} from "react-icons/lu";
import useSWR from "swr";
import { useIsAdmin } from "./use-is-admin";

export const ID_LIVE = 1;
export const ID_REVIEW = 2;
export const ID_EXPLORE = 3;
export const ID_EXPORT = 4;
export const ID_PLAYGROUND = 5;
export const ID_FACE_LIBRARY = 6;
export const ID_CLASSIFICATION = 7;
export const ID_CHAT = 8;

export default function useNavigation(
  variant: "primary" | "secondary" = "primary",
) {
  const { data: config } = useSWR<FrigateConfig>("config", {
    revalidateOnFocus: false,
  });
  const isAdmin = useIsAdmin();

  const hasChatAgent = useMemo(
    () =>
      Object.values(config?.genai ?? {}).some((agent) =>
        agent?.roles?.includes("chat"),
      ),
    [config?.genai],
  );

  return useMemo(
    () =>
      [
        {
          id: ID_LIVE,
          variant,
          icon: LuVideo,
          title: "menu.live.title",
          url: "/",
        },
        {
          id: ID_REVIEW,
          variant,
          icon: LuGalleryThumbnails,
          title: "menu.review",
          url: "/review",
        },
        {
          id: ID_EXPLORE,
          variant,
          icon: LuSearch,
          title: "menu.explore",
          url: "/explore",
        },
        {
          id: ID_EXPORT,
          variant,
          icon: LuFilm,
          title: "menu.export",
          url: "/export",
        },
        {
          id: ID_PLAYGROUND,
          variant,
          icon: LuConstruction,
          title: "menu.uiPlayground",
          url: "/playground",
          enabled: ENV !== "production",
        },
        {
          id: ID_FACE_LIBRARY,
          variant,
          icon: LuUsersRound,
          title: "menu.faceLibrary",
          url: "/faces",
          enabled: isDesktop && config?.face_recognition.enabled && isAdmin,
        },
        {
          id: ID_CLASSIFICATION,
          variant,
          icon: LuShapes,
          title: "menu.classification",
          url: "/classification",
          enabled: isDesktop && isAdmin,
        },
        {
          id: ID_CHAT,
          variant,
          icon: LuMessageCircle,
          title: "menu.chat",
          url: "/chat",
          enabled: isDesktop && isAdmin && hasChatAgent,
        },
      ] as NavData[],
    [config?.face_recognition?.enabled, hasChatAgent, variant, isAdmin],
  );
}
