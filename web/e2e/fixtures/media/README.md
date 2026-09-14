# Synthetic browser media fixtures

## Export preview fixture

`export-preview.webm` is a generated one-second black 64x64 VP8 video. It is
served for mocked export MP4 URLs with the correct WebM content type so browser
tests validate media readiness without depending on proprietary codec support.
This does not test Frigate's production export encoding.

Regenerate with:

```sh
ffmpeg -f lavfi -i color=c=black:s=64x64:r=5 -t 1 -an -c:v libvpx -b:v 20k export-preview.webm
```

## Live-playback retry fixture

`retry-h264.mp4` contains a generated 64x64 test pattern, not camera footage.
It is a 20-second fragmented H.264 MP4 with one fragment per second. The Retry
browser test sends those fragments over the mocked MSE WebSocket at their
normal cadence and checks decoded frames and sustained playback.

Regenerate with FFmpeg:

```sh
ffmpeg -f lavfi -i testsrc2=size=64x64:rate=5 -t 20 -an \
  -c:v libx264 -profile:v baseline -level:v 3.0 -pix_fmt yuv420p \
  -g 5 -bf 0 -movflags frag_keyframe+empty_moov+default_base_moof \
  retry-h264.mp4
```

H.264 keeps this UI recovery test portable across CI browser builds. HEVC
packet handling is covered separately by the go2rtc regression tests.
