# KoBOLD: The Kobold’s Tunnel

KoBOLD installs Tailscale on a supported Kobo so it can sync with a private
Calibre-Web server over any internet connection. Setup runs in a desktop browser
and transfers files over USB. No public Calibre-Web endpoint or hosted application
backend is required.

**Release status: 0.1.0 is being prepared for review. The public installer is not
live.** Production signing and installation acceptance remain closed pending review.

## Requirements

- Kobo Libra Colour, device code 390, firmware 4.46.23836.
- A desktop Chromium browser that supports folder selection and writing through
  the File System Access API. Development testing used Arc on macOS.
  Firefox, Zen and Safari cannot perform installation or folder backups.
- USB storage access to the reader and a private backup folder on your computer.
- A Tailscale account and Calibre-Web server reachable through that tailnet.
- An existing working Calibre-Web Kobo sync endpoint configured on the reader.

Other models and firmware versions are unsupported. Windows and Linux host testing
and survival across Kobo firmware updates have not been established. See
[compatibility](docs/HARDWARE-ACCEPTANCE.md).

## Setup

1. Select the Kobo and a backup folder. Create or verify an incremental backup.
2. Enter the server’s Tailscale address, port, reader name and device tag.
   Back up your current policy and validate the proposed changes in Tailscale.
3. Prepare library folders, restart the Kobo, and collect system settings.
4. Install the package, authorise the reader, and check its connection.
5. Set the sync address, test sync, and enable automatic startup.
6. Restart the Kobo and test sync using another internet connection.

Follow the current step in the app. Some steps require safely ejecting USB,
allowing an update or background task to finish, then reconnecting to read results.
A hotspot can be provided by any suitable internet connection. A phone’s Tailscale
connection does not automatically extend to devices using its hotspot.

Read the [user guide](docs/USER-GUIDE.md) before installation. Firmware-overlay
installation can fail and may require factory recovery. Keep all off-device backup
generations. KoBOLD does not promise a full system image or universal rollback.

## Updates

Use the update flow for a recognised KoBOLD installation and the exact release
that authorises its previous version. It preserves the enrolled Tailscale identity
and saves recovery records. The current updater covers matching managed controller
updates; arbitrary Tailscale payload upgrades and firmware changes require further
support and testing. Personal import and one-off development migration tools are
not part of the public distribution.

## Documentation

- [User guide](docs/USER-GUIDE.md)
- [Release notes](docs/RELEASE-NOTES.md)
- [Release review and signing plan](docs/RELEASE-REVIEW.md)
- [Backups](docs/BACKUPS.md) and [recovery](docs/RECOVERY.md)
- [Security and privacy](docs/SECURITY.md)
- [Architecture](docs/ARCHITECTURE.md) and [installation receipts](docs/INSTALLATION-PROVENANCE.md)
- [Building](docs/BUILDING.md) and [publication](docs/PUBLICATION.md)

## Development

Use Node.js 20+, Python 3.11+ and the pinned Go toolchain. No production npm
dependencies are required. See the build guide before generating signed packages.

```sh
python3 tools/prepare_toolchain.py --download
npm test
python3 tools/build.py --download
python3 tools/prepare_sources.py --download
npm run serve
```

An unsigned build cannot install. Production private keys belong outside the
repository and web root. Source is published through an explicit file inventory.

KoBOLD is independent software, unaffiliated with Rakuten Kobo or Tailscale.
Project source is MIT licensed. Bundled dependencies and fonts retain their own
licences. See [LICENSE](LICENSE).
