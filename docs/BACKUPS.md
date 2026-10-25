# Backups

Choose a private backup parent directory outside the reader volume. It contains
library files, configuration, account information and installation continuity
records. Browser storage and filesystem permissions do not encrypt these files.

## USB snapshots

The first snapshot copies included reader files. Later snapshots copy new or
changed files and reference unchanged data in earlier generations. SHA256 hashes
and readback checks establish content identity; equal timestamps or sizes alone
are insufficient. Keep all generations together. No automatic pruning occurs.

A format-2 manifest describes the whole snapshot and records each file's physical
storage generation. Deleted reader files remain recoverable from older snapshots.
Incomplete copies retain a marker and cannot become installation evidence. A
cancelled operation leaves earlier completed snapshots intact.

Only known operating-system index and trash directories at the volume root are
excluded, including macOS Spotlight/event/trash directories, Windows recycle and
volume-information directories, and Linux trash directories. Each exclusion is
recorded. Nested names, Kobo configuration and hidden library files are retained.
Unexpected read failures remain errors.

A backup's suitability is determined by its contents, not its age. Selected
snapshots are currently checked against the reader; several device-changing
operations also require full backup validation. Reducing repeated full checks to
operation-specific preconditions is planned, not a claim about all current paths.
Read-only diagnostic capture and the lightweight status page do not enumerate
or rehash the library backup.

## System and configuration copies

USB access cannot read the complete root filesystem. A signed collection helper
captures privileged settings after the firmware overlay is installed. The browser
copies the archive off-device, checks its digest and acknowledges that exact copy.
This archive is not a full pre-install system image.

Endpoint changes first save the existing configuration, preserve the token and
replace only its host/port. Applying library-scan exclusions also preserves the
configuration before changing the scoped setting. Reuse of these copies requires
matching reader identity and integrity checks.

Skipping the main snapshot requires an explicit, reader-bound risk receipt with
limited validity. It does not bypass privileged-system, signing, health or device
compatibility checks. The current fresh-install staging path requires a complete main backup even when
a skip receipt exists. A skip never authorises that installation path.

## Folder preparation

Set exclusions for owned installer namespaces before staging their payloads.
Safely eject, restart and reconnect, then confirm the same reader and setting.
This prevents installer documents entering the book index. The restart check is
user attestation plus configuration verification, not independent boot telemetry.
Changing exclusions over existing managed files requires a backed-up recovery
flow; a late setting change can cause previously indexed files to disappear.

Restore only what is needed. Restoring an old library database can roll back
reading progress, annotations and metadata. The app does not automatically restore
that database, delete books or overwrite an unknown installation.
