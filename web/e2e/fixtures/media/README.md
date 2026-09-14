# Export preview fixture

`export-preview.webm` is a generated one-second black 64x64 VP8 video. It is
served for mocked export MP4 URLs with the correct WebM content type so browser
tests validate media readiness without depending on proprietary codec support.
This does not test Frigate's production export encoding.

Regenerate with:

```sh
ffmpeg -f lavfi -i color=c=black:s=64x64:r=5 -t 1 -an -c:v libvpx -b:v 20k export-preview.webm
```
