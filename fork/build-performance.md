# Image build performance

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
