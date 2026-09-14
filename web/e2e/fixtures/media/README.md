# Synthetic live-playback fixture

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
