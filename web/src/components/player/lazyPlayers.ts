import { lazy } from "react";

// Each live player is its own chunk so a dashboard only downloads the one
// its stream mode needs; jsmpeg in particular is only used when go2rtc
// cannot serve webrtc or mse. Wrap the render site in Suspense.
export const WebRtcPlayer = lazy(() => import("./WebRTCPlayer"));
export const MSEPlayer = lazy(() => import("./MsePlayer"));
export const JSMpegPlayer = lazy(() => import("./JSMpegPlayer"));
