# Upstream bugs pinned by fork tests

The D73 coverage tests (#134) found bugs in upstream code. Each one is pinned
by a `# Upstream bug:` comment in `frigate/test/test_fork_cov_*.py`, so the
test asserts today's behavior and fails once the bug is fixed. When a pinned
test fails after an upstream sync, update the test to the fixed behavior and
move the bug to the fixed list here.

Checked against `upstream/dev` at `add310d63` (2026-10-17), updated by B35. This replaces the
bug list from #136, which was closed unmerged.

## Still open upstream

None. B35 fixed the last two in the fork, so no `# Upstream bug:` comment is
left in the tests.

## Fixed in the fork, still open upstream

Each fix is a small hunk marked `fork (B35)`. Drop it when upstream fixes the
bug, keeping the updated test.

- `frigate/data_processing/real_time/whisper_online.py`, `MLXWhisper.load_model`:
  with neither `model_dir` nor `modelsize`, `model_size_or_path` was never
  assigned, so loading raised `UnboundLocalError`. It now raises a
  `ValueError` that names the missing setting. Tested in
  `test_fork_cov_whisper_online.py` (`test_without_model_dir_or_size_fails`).
- `frigate/embeddings/maintainer.py`, `_process_updates` and
  `_process_frame_updates`: the `except FileNotFoundError` around
  `frame_manager.get` never assigned `yuv_frame`, so the following
  `if yuv_frame is None` raised `UnboundLocalError`. This was latent because
  `SharedMemoryFrameManager.get` returns `None` for a missing segment. Both
  now set `yuv_frame = None` in the `except`. Tested in
  `test_fork_cov_embeddings_maintainer.py` (two `test_frame_not_found_error`
  tests).

## Fixed upstream and ported to the fork

B35 ported these fixes from upstream dev and updated the tests that pinned them.

- `frigate/ptz/onvif.py`: a failed status call during setup disabled zooming
  even in absolute mode. Relative zoom is now configured only when `zooming`
  is `relative` (#24559). Tested in `test_fork_cov_ptz_onvif.py`
  (`test_status_failure_keeps_absolute_zooming`).
- `frigate/ptz/onvif.py`: a `False` return from `_init_onvif` never counted as a
  retry, so `max_retries` and the backoff never applied to unreachable
  cameras, and the reply after a successful retry left out `profiles`. Every
  failure now records `attempts + 1`, and the reply goes through
  `_camera_info` (#24559). Tested in `test_fork_cov_ptz_onvif.py`
  (`test_failed_init_counts_a_retry`).
- `frigate/ptz/autotrack.py`: `split_value` never suppressed small moves, and
  the unused `autotracked_object_region` raised `TypeError`. Both were removed
  in the autotracking cleanup (#24559). Tested in
  `test_fork_cov_ptz_autotrack.py`
  (`test_clips_moves_without_suppressing_small_ones`).
- `frigate/embeddings/embeddings.py`: with fewer events than one batch, reindex
  progress could pass 100 percent. `processed_objects` is now reset to 0 after
  the first progress message (#24528). Tested in `test_fork_cov_embeddings.py`.
