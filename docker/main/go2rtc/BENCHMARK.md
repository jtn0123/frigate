# HEVC startup validation

Measured September 14, 2026 on a Reolink CX810, AMD RX 6800 XT VAAPI
rotation pipeline, and Chrome on the local network. Frigate itself was not
upgraded. These measurements describe one installation, not universal defaults.

## Rotated Side Yard stream

Each trial opened a fresh MSE connection to an already active recording source.
`requestVideoFrameCallback` measured the first presented frame. Trials used
randomized 1.1 to 1.9 second gaps in the same browser profile. This measures
startup, not camera-to-screen latency. Batches were sequential and small.

| Encoder setting | Trials | Mean | Median | Nearest-rank p95 | Maximum | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| GOP 25, 8192k, 25 fps | 12 | 474 ms | 372 ms | 972 ms | 972 ms | 0 |
| GOP 12, 12288k, 25 fps | 24 | 360 ms | 350 ms | 548 ms | 636 ms | 0 |

Mean startup improved 24%; p95 improved 44%. The shorter GOP preserves H.265,
2160x3840 portrait output, audio, and rotation before recording. Detection and
camera-native encoding settings were unchanged. These are per-installation
configuration changes, not new global encoder defaults in this PR.

On the same 12-second night sample at matched 25 fps, SSIM was 0.989004 for
the original settings and 0.990155 for the selected settings. GOP 12 at the
original bitrate reduced SSIM to 0.986181, which is why bitrate was increased.
This short sample does not establish quality for every lighting condition.
Measured bitrate implies approximately 49 GB/day or 1.36 TB/28 days of extra
recording storage if sustained. Retention capacity must be checked locally.

Before times in ms: 802, 329, 291, 677, 721, 441, 299, 205, 208, 407, 337, 972.

After times in ms: 548, 541, 231, 400, 300, 188, 516, 440, 168, 461, 193, 217,
400, 420, 465, 218, 350, 456, 315, 250, 350, 250, 334, 636.

## Server and recording checks

A 178-second check with 90 samples found both added cameras at or above 5
capture fps, no skipped frames, no cgroup OOM or memory-limit events, and no
new camera errors after restart settled. Shared GPU memory stayed between
82.02% and 82.13%. Two fresh recording segments from each camera decoded
without errors, had increasing DTS, and retained correct dimensions. This is
a short validation window, not a sustained multi-client capacity test.

The synthetic VAAPI regression test checks portrait crop, all 50 output frames,
and GOP spacing. The prior GOP failed the new spacing bound; the selected
configuration passed on the server GPU. It runs without camera access and
requires explicit FFmpeg and render-device environment variables (see README).

## Alternatives evaluated

- Forwarding source keyframes through rotation was rejected because constant
  frame-rate duplication in low light could duplicate forced keyframes.
- Native H.265 WebRTC worked in 12 local trials, but median startup was 876 ms
  versus 372 ms for baseline MSE. This does not compare steady-state latency.
- Isolated FFmpeg 9 trials reduced process memory and CPU on the sample but
  showed no consistent wall-time gain. Production FFmpeg was retained.
- Isolated Mesa 26.2.2 trials showed no useful speed gain and higher resource
  consumption on the sample. Host drivers were retained.
- Sharing the VAAPI device and changing frame-rate handling did not provide
  sufficient benefit with preserved quality, so those experiments were reverted.

The native-camera ONVIF startup hook remains opt-in and was retained for
Backyard only. The rotated encoder controls its own output keyframes.
The diagnostic endpoint and error UI require deploying this PR's Frigate image;
the live timing measurements above used the patched go2rtc and camera pipeline.
