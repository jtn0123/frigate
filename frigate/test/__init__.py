from typing import Any

import frigate.util.config


async def _unreachable_stream_info(
    ffmpeg: Any, url: str, get_duration: bool = False
) -> dict[str, Any]:
    return {"width": 0, "height": 0, "fourcc": None}


# Validating a camera without detect dimensions probes its stream. Test streams
# are unreachable, so return the failed probe result instead of waiting ~12s per
# stream for ffprobe to time out.
# fork (B44): upstream replaces the probe on frigate.config.config's retriever,
# but importing that module here would load it into every forkserver child that
# imports a test module, which test_record_process_lifecycle must keep clean,
# so the probe the retriever awaits is replaced instead
frigate.util.config.get_video_properties = _unreachable_stream_info
