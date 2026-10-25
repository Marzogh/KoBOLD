# Installation receipts and trust

The protocol identity is `org.kobold.kobo-tailscale/v1`. Release manifests and root
descriptors use Ed25519 signatures from an independently reviewed public-key list.
The private release signer is never embedded in a page or reader package.

## Reader identity

The root helper creates a device signing key, installation ID and state record in
`/usr/local/kobold-state/installation.json`, outside USB storage with private
permissions. Receipts bind the reader identity hash, exact profile, descriptor,
request nonce, sequence, preceding digest and hashes of installed/report files.
Private device keys are not exported to the browser.

The selected backup parent holds the public trust pin and receipt history under
`kobold-installations/<identity-hash>/`. New backup generations reuse these records.
Missing records never authorise silent adoption of a different installation.
Copying a marker directory is not proof of managed provenance.

First-use pinning assumes a reviewed signed installer and trusted physical handoff.
Root access or a compromised initial handoff can forge a device identity. This is
continuity checking, not hardware attestation or an externally anchored audit log.

## Verification and state

The browser checks the expected nonce, signature, reader, key, installed bytes and
sequence before advancing its pin. Re-reading the same authenticated result is
idempotent. A stale latest-result pointer cannot satisfy a new request. Ordinary
same-key receipts can advance past unobserved sequences; this is not a complete
append-only history proof. Descriptor transitions require their explicit signed
authorisation and continuity checks.

Prepared means the initial inspection completed. Installed covers enrol/status;
healthy follows successful startup activation after connection and sync checks.
Disabled and removed states retain recovery information. Opening a sign-in page,
copying files or returning to the home screen never creates healthy state.

A durable root journal retains transaction state. Signed report data is committed
with the receipt before export, so interrupted export can reproduce that same
receipt without incrementing its sequence. Corrupt private state and conflicting
transactions require explicit recovery rather than silent key replacement.

## Managed updates

A signed transition binds exact old/new file inventories and unchanged trust keys.
Native rollback copies protect the scoped replacement. Where an earlier job saved
a receipt privately before export, a signed predecessor can bridge precisely the
known interrupted challenge. An unexplained history gap is refused. An interrupted
job is archived before it is retired after transition commit.

Existing manual installations and installs lacking their off-device pin are not
automatically adopted. Cross-computer recovery and arbitrary-version updates remain
separate work. Public updates require the canonical KoBOLD layout and an authorised
managed transition.
