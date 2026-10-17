# Upstream bugs pinned by fork tests

The D73 coverage tests (#134) found bugs in upstream code. Each one is pinned
by a `# Upstream bug:` comment in `frigate/test/test_fork_cov_*.py`, so the
test asserts today's behavior and fails once the bug is fixed. When a pinned
test fails after an upstream sync, update the test to the fixed behavior and
move the bug to the fixed list here.

Checked against `upstream/dev` at `add310d63` (2026-10-17). This replaces the
bug list from #136, which was closed unmerged.

## Still open upstream

- `frigate/data_processing/real_time/whisper_online.py`, `MLXWhisper.load_model`:
  with neither `model_dir` nor `modelsize`, `model_size_or_path` is never
  assigned, so loading raises `UnboundLocalError` instead of a clear
  configuration error. Pinned in `test_fork_cov_whisper_online.py`
  (`test_without_model_dir_or_size_fails`).
- `frigate/embeddings/maintainer.py`, `_process_updates` and
  `_process_frame_updates`: the `except FileNotFoundError` around
  `frame_manager.get` never assigns `yuv_frame`, so the following
  `if yuv_frame is None` raises `UnboundLocalError`. This is latent because
  `SharedMemoryFrameManager.get` returns `None` for a missing segment.
  Setting `yuv_frame = None` in the `except` fixes both. Pinned in
  `test_fork_cov_embeddings_maintainer.py` (two `test_frame_not_found_error`
  tests).

## Fixed on upstream dev, not yet in this fork

These arrive with the next upstream sync, and their pinned tests will need
updating then.

- `frigate/ptz/onvif.py`: a failed status call during setup disables zooming
  even in absolute mode. Upstream now configures relative zoom only when
  `zooming` is `relative` (#24559). Pinned in `test_fork_cov_ptz_onvif.py`
  (`test_status_failure_disables_absolute_zooming`).
- `frigate/ptz/onvif.py`: a `False` return from `_init_onvif` never counts as a
  retry, so `max_retries` and the backoff never apply to unreachable cameras.
  The reply after a successful retry also leaves out `profiles`. Upstream now
  records `attempts + 1` after every failure and replies through
  `_camera_info` (#24559). Pinned in `test_fork_cov_ptz_onvif.py`
  (`test_failed_init_does_not_count_a_retry`).
- `frigate/ptz/autotrack.py`: `split_value` never suppresses small moves, and
  the unused `autotracked_object_region` raises `TypeError`. Upstream removed
  both while cleaning up autotracking (#24559). Pinned in
  `test_fork_cov_ptz_autotrack.py` (`test_clips_and_suppresses_small_moves`,
  `test_autotracked_object_region_cannot_index_tracked_object`).
- `frigate/embeddings/embeddings.py`: with fewer events than one batch, reindex
  progress can pass 100 percent. Upstream now resets `processed_objects` to 0
  after the first progress message. Pinned in `test_fork_cov_embeddings.py`.
