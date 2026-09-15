/**
 * Tear down a WebRTC live peer connection (UI70).
 *
 * Closing an RTCPeerConnection does not stop the local tracks it sent, so a
 * microphone captured for two-way talk stays open (and the browser keeps its
 * recording indicator) until each sender's track is stopped.
 */
export function closePeerConnection(
  pc: Pick<RTCPeerConnection, "close" | "getSenders">,
): void {
  pc.getSenders().forEach((sender) => sender.track?.stop());
  pc.close();
}
