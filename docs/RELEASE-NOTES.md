# KoBOLD 0.1.0

Install Tailscale on a supported Kobo and sync with a private Calibre-Web server
over any internet connection.

[Open the installer](https://chipsncode.com/KoBOLD/).

## Features

- USB installation from a desktop browser.
- Incremental local backups and system-settings backups.
- Tailscale policy generation, sign-in and connection checks.
- Calibre-Web sync address setup and automatic startup.
- Signed packages, managed controller updates and recovery tools.

## Compatibility

Tested with Kobo Libra Colour, device code 390, firmware 4.46.23836, using Arc
on macOS. Installation, updates and sync after restart and over another internet
connection have been tested.

Other models, firmware versions and Windows/Linux hosts have not been tested.
Installation requires a desktop Chromium browser with File System Access support;
Firefox, Zen and Safari cannot perform the required folder operations. Survival
across Kobo firmware updates has not been tested.

Managed updates require a matching previous release and unchanged USB payload.
General Tailscale client-version upgrades are not supported in this version.

Tailscale 1.104.2 is included. Dependency licences and corresponding firewall
sources are bundled with the release. Read the [user guide](USER-GUIDE.md) and
[security documentation](SECURITY.md) before installing.
