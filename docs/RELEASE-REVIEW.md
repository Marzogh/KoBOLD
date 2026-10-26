# Release verification and deployment

The installer is published at https://chipsncode.com/KoBOLD/. Release archives and
checksums are available from https://github.com/Marzogh/KoBOLD/releases.

## Package verification

Release and collection manifests use Ed25519 signatures. The checked-in public
trust lists identify permitted signers. Keep private signing keys outside source,
release exports and the web root. Use encrypted key storage and retain a separate
recoverable backup. GitHub Actions receives no private signing key.

Key ID: `kobold-release-2026`. Public-key SHA256:
`b5c1bac10f799b7450dcabc0454c62c568548de1ad26c25696bc9da768289d88`.

The release acceptance record binds the bootstrap and collector hashes and
describes the scope of its test evidence. Production promotion signs that record
while preserving the device archives. See [compatibility](HARDWARE-ACCEPTANCE.md)
for supported hardware and unverified configurations.

## Publication

Export source and site files using `publication/files.json`. Keep private records,
credentials, backups and signing keys outside the published inventory. Include
dependency notices and corresponding sources with binary distributions.

The manual `release-pages.yml` workflow downloads the specified release ZIP, checks
its supplied SHA256, rejects unsafe archive paths and verifies signatures and
acceptance before deployment. It deploys those files without rebuilding them.
Source pushes do not deploy Pages. The separate preview workflow disables
installation and does not publish device packages.

After deployment, verify HTTPS, asset checksums and the installation gate. Retain
the previous static artifact for rollback. See [building](BUILDING.md) for tooling.
