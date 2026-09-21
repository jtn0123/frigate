# Runtime Python locks (F9)

`docker/main/requirements-wheels.txt` remains the human-maintained input.
The production wheel stage selects `fork/requirements-runtime-amd64.lock`
or `fork/requirements-runtime-arm64.lock` through Docker's `TARGETARCH`.
Both locks resolve CPython 3.11 on Linux with glibc 2.35 compatibility (the
Debian 12 base supplies 2.36). TensorFlow uses the appropriate architecture's
package. Shared accelerator versions are constrained by
`docker/main/constraints-runtime-addons.txt`.

Regenerate intentionally, review the package/version diff, and validate both
architectures before shipping:

```sh
python3 fork/scripts/runtime_lock.py --update
python3 fork/scripts/runtime_lock.py
python3 -m unittest discover -s fork/scripts -p test_runtime_lock.py
docker buildx build --target wheels --platform linux/amd64,linux/arm64 \
  --output type=cacheonly -f docker/main/Dockerfile .
```

Generation requires `uv` (initial locks generated with 0.11.6). It uses the
existing lock as a resolution preference; a package refresh can be requested
by running the recorded `uv pip compile` command with `--upgrade` and then
rerunning the generator to stamp and validate the inputs.

The build rejects changed inputs or manually edited generated contents until
the selected lock is regenerated.
The lock guards also run in the CI coverage job. Every runtime artifact must
match an explicit SHA256. The py3nvml dependency
uses the archive of the same full Git commit as before, since pip hash mode
does not support Git checkouts. Source-only dependencies such as Peewee still
build from their verified source archives; do not require binary-only inputs.

This locks the main runtime dependency closure, not every byte in the image.
Debian packages, native HailoRT/pysqlite3 sources, debug-only tools and isolated
source-build dependencies retain their separate build/update policies.
