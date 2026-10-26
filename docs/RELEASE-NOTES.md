# KoBOLD 0.1.0 release notes

Status: version 0.1.0 approved for publication on 2026-10-26.

## Included

- Browser-based USB setup for Kobo Libra Colour 390 on firmware 4.46.23836.
- Incremental local backups and separate privileged-settings collection.
- Tailscale policy proposal, sign-in and connection verification.
- Signed package validation, device receipts and interrupted-job recovery.
- Calibre-Web endpoint address update and automatic Tailscale startup.
- Managed controller updates, scoped recovery actions and local diagnostics.
- Canonical `.adds/kobold` storage and `/usr/local/kobold-0.1.0` system paths.

## Compatibility and limitations

Development hardware testing on macOS with Arc exercised installation, managed
updates, enrolment and startup. The owner reported successful sync after a full
restart and using a different internet connection. These results establish the
reported flows, not exact-artifact acceptance of the final public bundle.

Other hardware, other firmware, Windows/Linux hosts and survival across Kobo OS
updates remain unverified. Firefox-derived browsers and Safari cannot perform the
required filesystem actions. No claim is made that Kobo firmware updates preserve
this integration.

The current managed updater requires an authorised matching previous release and
unchanged USB payload inventory. General client-version upgrades are not supported
by this release. Personal SSH import and one-off namespace migrations are excluded.

Tailscale is pinned to 1.104.2. The bundled firewall userspace libraries are legacy
dependencies; checksum validation does not establish current security maintenance.
See [security](SECURITY.md) and the included dependency notices and source bundle.

## Release acceptance

The owner explicitly approved enabling installation using the earlier functional
installation, update, backup and sync evidence. The newly signed archive was not
retested on a reader. Its exact hashes and the approval basis are recorded in
[the release acceptance record](releases/0.1.0-acceptance.json). Promotion preserves
the approved bootstrap and collector archives while signing accepted metadata.
