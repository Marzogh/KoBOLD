# Architecture

KoBOLD has three components: a static browser application, a fixed-action reader
controller and a native receipt helper. Build tools produce versioned, signed
archives. No hosted application service or remote shell is required on the reader.

## Browser application

The browser accesses only folders selected by the user. It identifies the reader,
manages incremental backups, proposes a Tailscale policy and stages immutable
release files. Release assets are fetched from the same origin and verified
against authenticated metadata before use. Tailscale sign-in opens only its
recognised login URL in a new tab. Books and private configuration are not sent
to the hosting origin.

The File System Access API cannot provide exclusive volume access or an OS-level
fsync. Readback hashes detect changed content; they are not proof against power
loss or another application modifying the volume. Interrupted writes remain
explicitly incomplete.

## Reader integration

A scoped Kobo root-overlay package installs a detached udev bootstrap and a
fixed-action controller. It does not replace the bootloader, partitions, OS
libraries or Kobo library database. New installations use the canonical KoBOLD
namespace. Public updates require a recognised signed KoBOLD installation and an
authorised previous-release transition.

Requests contain a nonce, fixed action, exact profile, hostname and tag. Unknown,
duplicate or oversized fields are refused. Supported actions are inspect, enrol,
status, enable, disable and uninstall. No request contains shell code or an
arbitrary executable path. Native checks reject symlinks, altered payloads and
unexpected files, with narrowly bounded exceptions for recognised host metadata.

Tailscale executes from a verified RAM copy. Its enrolled identity and installation
key are stored on native root storage, outside the USB-exported volume. The client
does not advertise routes, accept DNS/routes or enable Tailscale SSH.

## Job completion

A durable root journal records a validated transaction before its USB request is
consumed. A committed receipt includes the report bytes needed to re-export the
same result without advancing the sequence. On remount, an interrupted job can
resume its exact transaction or export its committed result. The browser checks
the saved challenge, not merely the latest-result pointer.

A responding daemon is not necessarily ready. Native readiness sampling is
bounded; startup requires Running state, no health warnings and the configured
tag. Timeout or login-required states do not enable startup. The controller
retains safe outcome diagnostics without exporting private keys or raw health text.

## Root overlays and recovery

Firmware extracts an overlay before the installed helper runs. A collector
therefore cannot inspect root-path collisions before that first extraction.
USB backup, staged collection, exact supported profiles and recovery archives
reduce risk but do not provide a full disk image or transactional firmware loader.
See RECOVERY.md and HARDWARE-ACCEPTANCE.md for remaining acceptance requirements.
