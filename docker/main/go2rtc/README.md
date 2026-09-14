# H.265 aggregation packet fix

Frigate builds go2rtc v1.9.14 from its checksum-pinned source archive and applies
`hevc-aggregation.patch` before compiling either target architecture.

FFmpeg sends H.265 parameter sets (VPS, SPS, PPS) together in RFC 7798 RTP
aggregation packets, NAL type 48. The v1.9.14 depayloader treated this RTP wrapper
as an encoded NAL unit. Its MP4 output therefore contained aggregation framing
instead of usable in-band decoder parameters. Apple VideoToolbox rejected the
rotated VAAPI stream with `PIPELINE_ERROR_DECODE` / OSStatus -12909.

The patch unpacks aggregation packets into length-prefixed NAL units, retains
the access-unit marker behavior, and rejects truncated, undersized, and nested
aggregation payloads. Regression tests run in the Docker build. Captured camera
streams decoded without errors in FFmpeg and Apple VideoToolbox after the fix;
the original camera codec and resolution were retained.

The tests assume the non-DONL RTP mode used by FFmpeg. This does not add support
for optional decoding-order-number interleaving.

For an existing installation, Frigate's supported `/config/go2rtc` binary
override can run the same patch before an image is published. Once an image
contains this fix, remove that override so future bundled go2rtc updates take
effect. Do not remove it while using an image whose depayloader still lacks
aggregation support.

Targeted build check:

```sh
docker build --platform linux/amd64 --target go2rtc \
  -f docker/main/Dockerfile -t frigate-go2rtc-hevc-test .
```

The portrait VAAPI encoder can also emit padded coded dimensions in its in-band
SPS. Per-stream `hevc_metadata=width=2160:height=3840` sets the correct visible
crop in those headers. This is a separate camera pipeline setting, not a global
change to H.265 streams, and does not resize the video. The FFmpeg version must
support the bitstream filter's `width` and `height` options.

For `hvc1` recordings of this VAAPI output, append `-bsf:v extract_extradata`
to that camera's recording output arguments. It lets the MP4 muxer use the
parameter sets from actual encoded frames instead of the encoder's initial SDP
parameters. This retains video stream-copy and Apple-compatible `hvc1` labeling;
without it, live playback can work while recordings retain stale headers.

## Optional immediate keyframe request

`onvif-keyframe-startup.patch` adds an opt-in request after an MSE viewer
subscribes. On tested Reolink CX810 native H.265 streams,
`SetSynchronizationPoint` produces an extra keyframe, reducing the wait for the
next regular one. Example configuration:

```yaml
go2rtc:
  streams:
    backyard: rtsp://user:password@camera-address:554/Preview_01_main
  mp4:
    keyframe:
      backyard:
        port: 8000
        profile: "000"
```

The existing direct RTSP source supplies the camera address and credentials.
The hook uses `/onvif/media_service`; enable it only for cameras verified to
support this service and profile. It does not support FFmpeg rotation sources,
whose output encoder controls its own keyframes. No camera credentials are
added to player requests or the new configuration section.

Requests run asynchronously with a two-second deadline, one in-flight request
per configured stream, and a one-second cooldown. HTTP redirects are rejected,
response parsing is bounded, and SOAP faults leave normal playback waiting for
the regular keyframe. Debug logs contain the stream name and success/failure,
never camera response bodies or transport errors that could contain credentials.
There are no additional camera connections while nobody is opening the stream.

## Rotated stream performance validation

The production Side Yard benchmark retained the direct-camera ONVIF hook for
Backyard only. Forwarding source keyframes through the rotation encoder was
not retained: constant-rate duplication of low-light camera frames can also
duplicate forced keyframes. The tested alternative uses `-g 12` at 25 fps
(0.48 seconds between keyframes), with a 12288k rotation-encoder bitrate to
preserve measured detail. This increases recording storage; evaluate retention
capacity before applying these per-installation settings. It does not change
camera-native encoding, detection resolution, or the substream.

Run the opt-in synthetic GPU regression test with the same FFmpeg and driver
as the server. It verifies keyframe spacing, frame count, and portrait crop
without opening a camera connection:

```sh
FFMPEG_TEST_BIN=/usr/lib/ffmpeg/8.0/bin/ffmpeg \
VAAPI_TEST_DEVICE=/dev/dri/renderD128 \
python3 -u -m unittest frigate.test.test_hevc_keyframe_pipeline
```

The test skips when these environment variables are absent. See the local
performance benchmark report for before/after timing, quality, and dependency
comparisons. Newer FFmpeg and Mesa builds were isolated for evaluation; the
production dependency versions were retained.
