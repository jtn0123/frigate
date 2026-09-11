/**
 * QR SVG helper for clip share links (UI11).
 *
 * Encoding is vendored from uqr (MIT) so the UI never calls a third-party
 * QR service and we do not add an npm dependency.
 */

import { renderSVG as encodeSvg } from "./qr-encode";

type QrSvgFn = (
  text: string,
  options?: { pixelSize?: number; whiteColor?: string; blackColor?: string },
) => string;

const renderSVG = encodeSvg as QrSvgFn;

export function qrSvg(text: string, pixelSize = 8): string {
  return renderSVG(text, { pixelSize });
}
