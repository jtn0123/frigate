# Image build performance

## Versioned dependency images (second benchmark pass)

The proposed follow-up uses two graphs: `docker/fork-dependencies.hcl` publishes
the regular and ROCm runtime dependencies, and `docker/fork-runtime.hcl` adds
Frigate to those images. `fork/scripts/dependency_images.py` hashes all Docker
files, patches, installation scripts, lock files, label maps, and their file
permissions. Application and frontend edits do not change this dependency key.
Both image references are resolved to exact SHA256 digests before application
builds begin. A third, small scratch image holds only compiled frontend assets,
keyed by frontend source files and build definitions. A backend-only update
reuses it; a frontend edit rebuilds that artifact without rebuilding runtime
dependencies. The application graph imports all three images by digest and has
no compiler or package-install targets for those components.
The regular image's existing permissions setup runs in `frigate-runtime`, before
application files are added. Its final application copy uses `COPY --link`, as
the ROCm image already does. The setup script touches only system/runtime paths;
the comparison checks ownership, modes, user configuration, and image contents.
Registry errors fail the build rather than silently choosing a
different dependency image.

The refresh generation defaults to the current UTC month. The first build in a
new month regenerates dependency images, allowing normal layer-cache reuse;
this is not a scheduled rebuild
when no application builds run. An explicit `--refresh` value can force an
earlier generation. Changing that generation alone does not force cached package
installation steps to rerun. For an OS/package security refresh, use
`--rebuild-dependencies`, which bypasses dependency layer caches and pulls base
images. This deliberately expensive maintenance build is separate from normal
application updates. Runtime images and old dependency digests must be retained in
the registry for reproducible rebuilds. The two dependency variants use the
same settings as the fork release: AMD64 and ROCm 7.2.3 with HSA override disabled.

The second comparison measures the previous shared-builder version against this
proposal. Both use fresh builders, identical immutable seed caches, the same USB
volume, 4 VM CPUs, 6 GiB VM memory, a 5 GiB builder cap, and two concurrent build
operations. The candidate's first phase includes building and publishing its
dependency images and frontend artifact. Its application-change phase reuses
those images but starts
with a new builder. Registry lookups, builds, and cache/image export all count
toward elapsed time. Dependency preparation and application build times are
also reported separately. Results are pending; the table below is the completed
first comparison, not a measurement of this follow-up.

Pass `--case dependency-images` and the same `--buildkit-image` digest to
`fork/scripts/benchmark_image_build.py` for this candidate. Compare against
`--case shared-zstd` on the previous source snapshot. Both cases must start with
isolated registry data; preserve their inventories before removing task-created
images and registry data. Large snapshot copies and other builds should run
outside measured intervals.

## Previous shared-builder implementation

The release workflow builds AMD64 and ROCm with one Bake invocation. Their
common dependency and frontend stages can be shared in the same builder.
BuildKit concurrency is limited to two operations to bound simultaneous compiler
and Node workloads. The release job waits for both images to finish publishing.

ROCm copies the application after Python dependencies, GPU libraries, and
`ldconfig`. An application-only change therefore leaves those expensive layers
eligible for cache reuse. The final `COPY --link` keeps application files in an
independent layer that supports rebasing when the dependency cache is reusable.
The measurements below still exposed dependency cache misses.
The destination directories are real directories with the same ownership/modes
as the application stage, rather than symlinks. Registry caches use Zstandard
level 3, with separate AMD64 and ROCm cache manifests to avoid concurrent writers to the same tag.

## Local comparison

Use a dedicated Docker context, `colima-frigate-build-bench`, and a local registry
at `localhost:5007`. Keep its VM disk, source snapshots, and results on the same
external volume. Do not benchmark against the recording server.

The benchmark script runs two phases for each case:

1. Fresh builder: an empty case-specific cache plus the same immutable CI cache
   snapshot for both cases. The JSON result calls this phase `cold`; it means
   a cold local builder, not a build without dependency caches.
2. Application change: another new builder, importing that case's exported
   caches and the same immutable seed caches, with an identical marker file
   added to the application source.

The baseline builds AMD64 and ROCm sequentially on separate builders. The shared
cases build both targets together. All cases use four VM CPUs, 6 GiB VM memory,
a 5 GiB builder memory limit, no builder swap, and two concurrent BuildKit
operations. Run cases sequentially to avoid competing for host CPU and USB I/O.

Prepare two clean source snapshots at the same commit. Only the candidate ROCm
Dockerfile differs; the candidate also includes `docker/fork.hcl`. Generate the
same `frigate/version.py` in both snapshots. Source directories must be writable
and must not contain `frigate/build_benchmark_marker.txt` before a run.

```sh
# Registry data is held on the benchmark VM's external-volume disk.
docker --context colima-frigate-build-bench run -d \
  --name frigate-bench-registry -p 127.0.0.1:5007:5000 \
  -v frigate-bench-registry:/var/lib/registry registry:2

python3 fork/scripts/benchmark_image_build.py \
  --source /Volumes/512Flash/frigate-build-bench \
  --output /Volumes/512Flash/frigate-build-results/baseline --case baseline \
  --seed-caches /Volumes/512Flash/frigate-build-results/seed-caches.json

python3 fork/scripts/benchmark_image_build.py \
  --source /Volumes/512Flash/frigate-build-candidate \
  --output /Volumes/512Flash/frigate-build-results/shared-zstd --case shared-zstd \
  --seed-caches /Volumes/512Flash/frigate-build-results/seed-caches.json
```

Before switching cases, record image smoke-test results and remove only the
benchmark registry container and its named volume, then recreate them. This
prevents cross-case blob reuse and keeps disk usage bounded. Never prune shared
Docker contexts or other users' images. Keep at least 20 GiB free on the host
volume and 8 GiB in the VM; stop the benchmark if either reserve is exhausted.

The script saves full BuildKit logs, image metadata, and elapsed seconds. Timings
include building and exporting, but exclude builder creation and removal. Build
failures are failures, not timing samples. Compare each phase with
`100 * (baseline_seconds - candidate_seconds) / baseline_seconds`.
Repeat measurements before treating a small difference as meaningful. Match
resolved base-image digests, package versions, and application contents, and
check both images' Python imports, runtime configuration, directory permissions,
and nginx/FFmpeg/go2rtc binaries.
GPU execution must be checked separately on AMD hardware.

ARM Mac measurements include AMD64 emulation and local-registry I/O. They do not
predict GitHub wall-clock time or GHCR upload performance. After local validation,
repeat on native AMD64 GitHub runners with benchmark-only tags and caches.

The seed file contains a JSON list of `ghcr.io/owner/image@sha256:...` references.
Resolve them once before either case. Mutable tags are rejected so a concurrent
CI build cannot change the comparison inputs. Without this option, the script
performs a completely uncached build, which can spend substantial time
recompiling unchanged drivers under emulation.

BuildKit's Rosetta capability probe can fail with SIGTRAP and select its built-in
QEMU emulator; see [upstream issue 7052](https://github.com/moby/buildkit/issues/7052).
Record the actual emulator used and keep it identical across cases.

## Measured local result, September 14, 2026

The source snapshot was `4c36f5356`. Both cases used the same immutable seed
caches, resolved base-image digests, USB volume, and resource limits. Each table
entry is one completed measurement, not a statistical average.

| Phase | Baseline | Shared builder | Reduction |
| --- | ---: | ---: | ---: |
| Fresh builder with seed caches | 89.64 minutes | 71.90 minutes | 19.79% |
| Application-only update | 62.29 minutes | 55.36 minutes | 11.12% |

The first row saved 17 minutes 45 seconds; the update saved 6 minutes 56 seconds.
USB throughput varied, and these ARM Mac measurements do not establish a GitHub
speedup. The compression change was not measured separately from shared builds
and Dockerfile ordering.

Both AMD64 and ROCm images passed Python import and nginx/go2rtc/FFmpeg smoke
checks. Application file hashes, Python packages, binary hashes, directory
ownership/modes, and runtime image configuration matched the baseline. The
1.61 GB compressed GPU-library layer had the exact same digest. This verifies
image contents; it does not substitute for execution on an AMD GPU.

The maximum sampled builder working memory was 3.76 GiB for the baseline and
3.80 GiB for the candidate, under the same 5 GiB hard cap. Neither resource guard
triggered. The candidate retained at least 73.67 GiB free on the USB volume and
43.66 GiB inside the VM. Working-memory samples are not a continuous peak, and
the baseline had a 134-second monitoring gap. Full limits and samples are
summarized in the data file below.

### Remaining cache misses

The application update still reran ROCm package-install and GPU-copy stages.
Consequently, its changed compressed image layers remained about 118 MB in both
cases; the application-copy move did not produce a measured payload reduction.
Do not describe this change as eliminating all ROCm rebuild work.

Further log inspection distinguishes actual commands from cache materialization:
the long frontend and Intel-driver stages showed layer extraction without command
output, while the ROCm pip stage printed uninstall/install output. A long `RUN`
heading followed by `DONE` does not by itself prove recompilation. Loading and
unpacking cached intermediate images was also a substantial cost on the USB.

A small two-image reproduction also reran the unchanged variant dependency
command on repeated application updates. Linking both children to shared parents
and running the variant first on one builder did not eliminate the misses
reliably. Those alternatives were not adopted. This resembles the cache-lookup
ordering behavior described in [BuildKit issue 4674](https://github.com/moby/buildkit/issues/4674),
but the exact internal cause in this build was not conclusively isolated.

The release changes retain the configuration measured above. Repeat the
comparison on native GitHub runners with isolated benchmark tags/caches before
claiming a CI percentage. No production server or release tags were changed by
the local benchmark.

Machine-readable results: [image-build-2026-09-14.json](benchmarks/image-build-2026-09-14.json).
Full local logs, manifests, smoke inventories, source hashes, and cache probes
are retained in `/Volumes/512Flash/frigate-build-results`.

### Native GitHub benchmark and reporting requirements

The second local baseline completed its build and cache exports, but builder
removal timed out before the original runner wrote its timing summary. Its raw
logs and images remain available. That incomplete local comparison is not a
measured speedup for versioned dependency images.

`fork-build-benchmark.yml` measures the previous shared-Zstandard graph against
the dependency-image graph on one disposable Ubuntu 22.04 AMD64 runner. This is
a separate dataset from the Mac/USB measurements. Both cases use the same
immutable seed caches, source version, BuildKit digest, 5 GiB builder memory
limit with no additional swap, and two concurrent BuildKit operations. Each
phase gets a fresh builder. The local registry is reset between cases. Native
stages now run on AMD64 in both cases. The workflow never publishes release
images or changes server tags.

The baseline is pinned to `f0fc3760785792d22b98c847078e86b18910824d`.
The candidate is the workflow commit. Each case measures initial preparation
and a subsequent identical application change. Initial dependency preparation
is included in the first phase, not hidden from the result.

Reporting requirements:

- Checkpoint start, running state, elapsed time, exit status, and milestones in
  atomic JSON files. Persist final timing before attempting builder cleanup.
- Print a heartbeat every 30 seconds and completed image/cache milestones.
  Milestone timestamps have up to approximately 30 seconds of sampling delay.
- Show elapsed-time reductions only against a completed matching baseline.
  Positive values mean faster, negative values mean slower. Overlapping stage
  durations must not be added or averaged into a claimed total speedup.
- Never display a guessed overall completion percentage. The complete phase
  comparison is available once both phase measurements finish.
- Upload checkpoints after every phase, including failed runs, and publish
  partial tables in the Actions job summary. Failed cleanup stops subsequent
  work but cannot erase the already saved build timing.
- Preserve machine/tool/source/cache metadata and validate image application
  hashes, packages, binaries, permissions, and configuration before accepting
  the comparison. This is not a test of physical GPU execution.

The first native pair is exploratory. Repeat matched runs to measure spread
before describing an average or promising a routine build-time target. Ordinary
hosted-runner logs survive an interrupted job; artifact upload remains best
effort on cancellation or loss of the runner itself.

The native sweep tests BuildKit concurrency 1, 2, and 4. Each matrix job runs
both versions sequentially on its own identical runner class and retains the
same 5 GiB builder cap. Actual CPU and runner image metadata are saved because
separate hosted VMs can differ. A failed high-concurrency build counts as a
failure, not a fast result. This first sweep selects candidates for repeated
measurements; it does not establish a statistically reliable optimum.

The first native sweep (Actions run `34920586264`) exposed a benchmark guard
bug: the same 5 GiB free-space threshold was applied to both the small runner
log partition and the much larger Docker partition. Concurrency 1 stopped on
its app update, and concurrency 2 stopped during candidate preparation, while
Docker still had ample space. These stops are not concurrency build failures.
The corrected guard retains 2 GiB for runner logs and 5 GiB for Docker, with
separate readings and an explicit saved error. Hardware, partitions, worker
limits, and cache settings remain unchanged for the repeat sweep.

The same first sweep also caught a real application-graph failure at concurrency
4: the Dockerfile frontend attempted to resolve the unused internal `deps` stage
as `docker.io/library/deps:latest`, despite overriding the later runtime stage.
The application graph now uses dedicated, minimal rootfs and final-image
Dockerfiles. A real tiny-image preflight verifies both variants can consume
published runtime/frontend image contexts and preserve expected application
files. It runs before timed CI work, so graph-resolution defects fail quickly.
A regression check also keeps the isolated rootfs COPY instructions in sync
with the main Dockerfile. The intermediate guard-only repeat was canceled when
this additional failure became known; it is not a completed comparison.
