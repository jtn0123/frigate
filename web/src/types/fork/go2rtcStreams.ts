/**
 * Fork (UI146): the parts of upstream's GET /api/go2rtc/streams that the
 * live telemetry cards read.
 *
 * The endpoint passes go2rtc's own `/api/streams` through, with credentials
 * removed from producer URLs. Only the consumer fields used to tell a person
 * watching from one of Frigate's own readers are typed here; go2rtc sends
 * more (SDP, medias, byte counters), and those stay `unknown`.
 */

/**
 * One reader attached to a go2rtc stream.
 *
 * go2rtc 1.9 writes `format_name` (`rtsp`, `mse/fmp4`, `webrtc/json`,
 * `hls/fmp4`, `mjpeg`, ...) and `protocol` (`rtsp+tcp`, `ws`, `http`).
 * Releases before 1.9 wrote a single `type` such as "RTSP server consumer"
 * instead. `remote_addr` is `host:port`, followed by ` forwarded <X-Forwarded-For>`
 * when the request came through a proxy such as Frigate's nginx. A WebRTC
 * reader has no `remote_addr` until ICE picks a candidate pair, and then
 * `host:port <candidate type>`. `bytes_send` is left out while it is 0, and
 * go2rtc does not report it for RTSP readers at all.
 */
export type Go2rtcConsumer = {
  format_name?: string;
  type?: string;
  protocol?: string;
  remote_addr?: string;
  user_agent?: string;
  bytes_send?: number;
};

export type Go2rtcStreamEntry = {
  producers?: unknown[] | null;
  /** go2rtc writes `null` rather than `[]` for a stream nobody reads. */
  consumers?: Go2rtcConsumer[] | null;
};

/** Stream name to its producers and consumers; a name may be missing. */
export type Go2rtcStreamsResponse = Partial<Record<string, Go2rtcStreamEntry>>;
