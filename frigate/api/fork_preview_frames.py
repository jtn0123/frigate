"""Selection of a camera's cached preview frames for the preview GIF and MP4."""

import os

from frigate.const import PREVIEW_FRAME_TYPE


def select_preview_frames(
    preview_dir: str, camera_name: str, start_ts: float, end_ts: float
) -> list[str]:
    """List a camera's cached preview frames within a time range, oldest first.

    This scans the directory that holds every camera's frames, so async
    handlers must call it through `asyncio.to_thread`.

    Frames are named `preview_{camera}-{timestamp}.{type}`. Camera names may
    contain "-", so the part before the last "-" is compared as a whole: the
    prefix of camera `cam` would also match the frames of `cam-1`.

    Args:
        preview_dir: Directory holding the cached frames of all cameras
        camera_name: Camera whose frames are wanted
        start_ts: Start of the range, inclusive
        end_ts: End of the range, inclusive

    Returns:
        File names within the range, or an empty list when the directory does
        not exist
    """
    file_start = f"preview_{camera_name}"
    start_file = f"{file_start}-{start_ts}.{PREVIEW_FRAME_TYPE}"
    end_file = f"{file_start}-{end_ts}.{PREVIEW_FRAME_TYPE}"

    try:
        with os.scandir(preview_dir) as entries:
            camera_files = [
                entry.name
                for entry in entries
                if entry.name.rsplit("-", 1)[0] == file_start
            ]
    except (FileNotFoundError, NotADirectoryError):
        return []

    return sorted(file for file in camera_files if start_file <= file <= end_file)
