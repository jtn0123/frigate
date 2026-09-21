# Deploying and rolling back the fork

This is an owner-operated runbook. These instructions do not deploy anything
when the repository checks run. Use the deployment definition and storage paths
of the actual server; the local demo is a separate installation.

## Select a release

Read the release notes and confirm the desired variant finished successfully
in **Fork - Build**. GitHub releases are named `fork/<version>`, but container
images are `ghcr.io/jtn0123/frigate:<version>` for the standard build and
`ghcr.io/jtn0123/frigate:<version>-rocm` for AMD ROCm. Do not put `fork/` in an
image tag. Match the architecture and acceleration of the existing deployment.

The `main` and `main-rocm` tags move on promotion. Version tags are better for
repeatable deployment, but a workflow rerun can publish the version again.
For an exact pin, resolve and save the image digest and use
`ghcr.io/jtn0123/frigate@sha256:<digest>` in the deployment definition. Record
which variant the digest belongs to. Keep the previous digest locally available.

Promotion is a separate owner action (`make promote`). It checks the required
checks on the exact `next` revision and moves the release branch. Deploying an
already published image does not require another promotion. See
[`promote.sh`](scripts/promote.sh) and [the build workflow](../.github/workflows/fork-build.yml).

## Before changing the server

1. Record the current image reference, image ID/digest, application version,
   deployment definition, environment, mounts, devices and network settings.
   Back up these records securely because configuration may contain credentials.
2. Read migrations between the running and target versions. Budget downtime
   and enough free space for the database backup and new image.
3. Pull the target image before the outage. Stop Frigate using the server's
   existing deployment manager. Confirm no other process is writing its DB.
4. Take a restorable, versioned copy or snapshot of the complete `/config`
   storage and any database stored outside it. Preserve the SQLite database
   and any `-wal` or `-shm` sidecars that exist. Do not copy only a live database
   file. Keep backups outside storage that a stack replacement could delete.
5. Confirm the backup can be read and that its paths, ownership and permissions
   are recorded. Retain media separately if it must survive storage changes.

Frigate's startup migration code can copy `frigate.db` to `backup.db` when
migrations are pending. That single file is not a versioned backup strategy
and may be overwritten. It does not replace the stopped snapshot above.

## Apply and verify

Change only the image reference in the existing deployment definition, then
recreate/start the service with the same storage and device access. For a
Compose deployment, use its established project directory and service name;
for Portainer, update its existing stack. Do not create a second writer against
the same configuration/database volumes.

Verify each of the following on the running server:

- The container uses the intended image ID/digest, and startup logs report
  the intended version with successful migrations and detector initialization.
- There is no restart loop. Storage mounts are writable and have free capacity.
- Every enabled camera advances live frames and reports plausible capture and
  detection rates. Test configured hardware acceleration rather than assuming
  a healthy container proves it is active.
- Create activity that qualifies for the configured recording retention rules.
  Confirm new segments after deployment and play them back. Recording enabled
  alone does not imply continuous retention is configured.
- Confirm a new review event and the audio/notification integrations you use.
  Check logs for recurring decoder, database, permission and storage errors.

A successful build, passing tests or healthy container status alone does not
prove that cameras, recording or acceleration work on this server.

## Roll back

Stop the service first and preserve the failed deployment's logs and current
state for diagnosis. If the database schema or configuration changed, restore
the matching pre-upgrade database **and configuration** before starting the
previous image digest. Restore ownership/permissions and use the original
mounts/devices. Never start an old image against a newer schema on the assumption
that startup will downgrade it.

Migration 036 introduces share-link state. Its rollback removes that state;
later migrations can add other incompatibilities. Frigate does not automatically
run reverse migrations on image downgrade. Restoring the pre-upgrade snapshot
is the rollback mechanism, not manually calling migration rollback functions.

Restoring a snapshot loses database/configuration changes made after it,
including new event metadata, review state and shares. Keeping raw recordings
does not automatically reconstruct their database index. Explain that recovery
point before restoring, then repeat the same camera, recording, playback and
integration checks against the old version. Retain the target image and backup
until the cause of the failed upgrade is understood.
