# Installation sequence

1. Select a supported reader and a private backup parent. Establish the backup
   required by the installation policy.
2. Configure a restricted Tailscale policy and confirm its validation.
3. Save configuration and prepare owned folder-scan exclusions. Eject, restart,
   reconnect and verify the same reader and setting before staging payloads.
4. Run the signed settings collector. Verify and copy its privileged archive, then
   update the incremental USB snapshot to include newly created files.
5. Stage all signed installer assets and verify their readback before queuing the
   root overlay last. On USB return, verify the native receipt and system archive.
6. For a new enrolment, obtain a sign-in link and authorise through Tailscale. For
   an enrolled managed reader, check its existing connection first. Require actual
   Running state, health and tag evidence.
7. Recognise an existing exact sync endpoint or back up and update only its address.
   Confirm real sync, then request startup activation and verify its signed result.
8. Test a full restart and another internet connection.

Refresh must not dispatch a queued write again. Physical USB-cycle acknowledgement
is distinct from native completion. Status reads, diagnostic capture and restored
visual state must not grant install permissions or silently accept an old result.

A new installation may retire previous off-device records only after verified
collection establishes the absence of managed root paths. Preserve those records
in a separate recovery namespace first. Existing managed updates use the explicit
signed transition rather than a fresh-install shortcut.
