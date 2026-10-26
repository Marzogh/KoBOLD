# Compatibility and test coverage

Supported target: Kobo Libra Colour, device code 390, firmware 4.46.23836, ARMv7
and kernel 4.9.77. Other profiles are blocked. Desktop testing used Arc on macOS.

Installation, enrolment, managed controller updates, signed startup verification
and sync after restart and over another internet connection have been tested.
The signed 0.1.0 distribution carries that earlier functional evidence; its new
archive was not separately rerun on hardware. The [release record](releases/0.1.0-acceptance.json)
distinguishes these scopes.

Other models, other firmware, Windows/Linux hosts and survival across Kobo OS
updates have not been tested. Native fixture tests and browser tests do not
establish hardware compatibility.

## Recording future test results

Record the model, firmware, browser, host OS and exact archive hashes. Exclude
reader serials and credentials. Check USB and system backups, library exclusions,
installation, enrolment, sync, startup after reboot and another internet connection.
Record interruption, storage exhaustion and recovery behaviour separately.
Updates must preserve the enrolled identity and existing books and settings.
