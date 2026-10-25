# Release review: KoBOLD 0.1.0

Prepared for owner review. No upload, GitHub push, Pages deployment or reader change
is authorised by this document.

## Public contents

Publish one clean initial source commit from the reviewed allowlist. Include the
browser app, canonical installer/controller, normal managed updater, tests, build
tools, notices and user/maintainer documentation. Exclude development history,
agent instructions, private working notes, backups, reader data, personal import
code, one-off migrations and private signing keys.

The intended repository is `Marzogh/KoBOLD`. The project’s expected Pages location
is `https://chipsncode.com/KoBOLD/`, subject to GitHub’s final Pages configuration.
No custom-domain or DNS change is part of this preparation.

## Signing plan

Use an Ed25519 production release key held outside Git, release exports and the
web root. Keep an encrypted off-device backup under the owner’s control. Publish
only the public verification key. Do not put a production private key in GitHub
Actions. Sign the release descriptor, release manifest and settings collector
locally, then verify their signatures and archive inventories before upload.

A review candidate may use a separate disposable review key. Such signatures prove
that the packaging and verification agree; they do not activate production trust
or constitute hardware acceptance. Keep candidate metadata non-installable.

## Approval items

1. Review README, user guide, release notes, compatibility and security limits.
2. Approve the supported profile and the remaining exact-artifact acceptance plan.
3. Approve production key creation/storage and public-key fingerprints.
4. Review signed install/update/collector manifests, checksums, notices and
   corresponding sources. Bind acceptance evidence to those exact archives.
5. Confirm source and site archives contain no private or personal material.
6. Approve the clean initial commit and GitHub release assets.
7. Approve upload and manual Pages deployment separately.

Production profile acceptance is currently false and production trust lists are
empty. Do not change either to bypass unfinished release review. Packaging tests
and owner-reported hardware results must be recorded separately.

## Deployment plan

Push only the reviewed clean `main` snapshot. Upload immutable reviewed release
assets and corresponding sources. Deploy only a verified static bundle using the
manual Pages workflow and the `github-pages` environment. Source pushes alone must
not deploy. The existing preview workflow publishes a non-installing preview and
must not be described as the live installer.

A deployable installer bundle must have approved production keys, accepted profile,
authenticated manifests and complete source/licence material. The reviewed archive
and its SHA256, not a rebuild with changed inputs, are the deployment unit. Record
the final Pages URL and check asset fetches and browser capability gating after
activation. Keep the previous static artifact available for rollback.
