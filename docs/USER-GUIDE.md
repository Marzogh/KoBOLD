# User guide

## Before you start

Check the model and firmware against [compatibility](HARDWARE-ACCEPTANCE.md).
Charge the reader and use a reliable USB cable. Close Calibre and other applications
that might modify its files. Keep the backup folder on your computer, outside the
Kobo volume. It contains private account settings, books and device records.

An interrupted firmware-overlay installation may require factory recovery.
Do not install on an unsupported model or assume an ordinary library backup is a
complete system image.

## Reader and backup

Connect the Kobo and choose USB storage mode. Select its root folder and a private
backup parent folder in the app. The first backup copies the included reader files;
subsequent backups copy changed files and refer to earlier generations. Keep all
generations together. Content matching determines whether a backup is current.

The main USB snapshot includes books, the library database, settings, hidden reader
files and installation records. Known operating-system index and trash directories
are excluded. A separate on-reader collector later captures privileged system
settings that USB cannot read. See [backup details](BACKUPS.md).

A skip acknowledgement does not bypass mandatory installation or system backups.

## Tailscale settings

Use the server’s Tailscale IPv4 address, not its home-network address. Enter the
Calibre-Web TCP port, a reader hostname, a device tag and its owner. Defaults are
`tag:kobo-sync` and `autogroup:admin`; use values appropriate to your tailnet.

Open the [Tailscale JSON policy editor](https://console.tailscale.com/admin/acls/file)
in another tab. Save an unchanged copy of your current JSON before editing it.
Paste that policy into KoBOLD, generate the proposal and validate it in Tailscale.
The app does not save policy changes to your account. Confirm completion in the app
only after Tailscale accepts both the policy and its tests.

Grants are additive. A broad existing rule can give the reader more access than the
new narrow rule. Replacing a wildcard source with `autogroup:member` changes access
for tagged devices. The app must not be treated as a guarantee that all existing
access remains suitable. Deny tests check the resulting policy; they do not create
firewall deny rules. Keep the saved policy so you can restore it if needed.

## Installation

Prepare library folders before copying installer payloads. Safely eject, restart
the reader, reconnect USB and confirm the folder setting in the app. This keeps
installer documents out of My Books.

Run system collection, then follow the eject and reconnect instructions. The Kobo
may show an update and restart. Wait until it returns to the home screen before
reconnecting. Read the result and save the system backup. The app also refreshes
the incremental USB backup where required.

Prepare installation. Safely eject and disconnect USB, let the Kobo apply its
update and return to its home screen, then reconnect and read the result. Do not
unplug during an update or infer success from the home screen alone.

## Authorise and connect

Prepare the current authorisation action, eject USB and allow Wi-Fi to connect.
Background network work may show no separate Kobo screen. Reconnect USB and read
the result to obtain the Tailscale sign-in link. Open it, authorise the reader with
the intended tag, then perform the app’s connection check. Existing enrolment is
retained on supported updates; do not delete the device just to repeat setup.

The browser cannot monitor the reader while it is disconnected. Each requested
check needs its own matching result after the requested USB cycle.

## Sync and automatic startup

Use the app to check or update the existing Calibre-Web sync address. It preserves
the token and backs up the previous configuration. Eject USB, connect Wi-Fi and run
Sync on the Kobo. Reconnect and confirm the real sync test before enabling startup.

After startup activation is verified, restart the Kobo and test sync over another
internet connection. The library remains behind your tailnet’s access policy.

## Refresh, diagnostics and recovery

Session settings can survive an accidental refresh. Re-select folders or grant
permissions again when prompted. Saved UI progress does not replace signed reader
results. Browser storage is not an encrypted backup and may be restored by browser
session recovery after a window closes.

If an operation fails, keep USB connected and use the app’s diagnostics. Review
reports before sharing: remove tokens, sign-in URLs, reader identifiers, policy
contents and book details. Do not manually delete controller locks or continuity
records. Follow [recovery](RECOVERY.md) for supported disable and restore options.
