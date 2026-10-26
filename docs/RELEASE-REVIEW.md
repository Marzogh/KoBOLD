# Release review: KoBOLD 0.1.0

Documentation and source publication approved by the owner on 2026-10-26.
Production packaging is in preparation. Exact-package hardware acceptance and
installer activation remain pending. No reader changes are performed by packaging.

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

Production profile acceptance is currently false. Public verification keys are
configured; the encrypted private signer is held outside the repository. Do not change either to bypass unfinished release review. Packaging tests
and owner-reported hardware results must be recorded separately.

## Deployment plan

Push only the reviewed clean `main` snapshot. Upload immutable reviewed release
assets and corresponding sources. Deploy only a verified static bundle using the
manual Pages workflow and the `github-pages` environment. Source pushes alone must
not deploy. The separate preview workflow publishes a non-installing preview and
must not be described as the live installer. `release-pages.yml` deploys only an
authenticated accepted site ZIP with its reviewed checksum.

A deployable installer bundle must have approved production keys, accepted profile,
authenticated manifests and complete source/licence material. The reviewed archive
and its SHA256, not a rebuild with changed inputs, are the deployment unit. Record
the final Pages URL and check asset fetches and browser capability gating after
activation. Keep the previous static artifact available for rollback.

## Prepared production key

Key ID: `kobold-release-2026`. Raw Ed25519 public-key SHA256:
`b5c1bac10f799b7450dcabc0454c62c568548de1ad26c25696bc9da768289d88`.

The private PEM is encrypted outside the repository. Its passphrase is held in the
owner’s macOS Keychain. An off-device encrypted key backup remains an owner action
before stable release. GitHub and Pages receive only the public verification keys.

The staged attended package is not public installation acceptance. Record its exact
bootstrap and collector hashes after the supported flow succeeds, then promote the
same archives. Ordinary source publication does not activate this package.

## Activation decision, 2026-10-26

The owner explicitly approved releasing the package using prior successful tests,
with the new exact signed archive not separately hardware-tested. This approval
supersedes the pending extra-test step above. The signed acceptance record states
that limitation and binds the package and collector hashes. It does not manufacture
an exact-archive test result. Public installation and Pages deployment are authorised.
