# Compatibility and release acceptance

The current profile is Kobo Libra Colour, device code 390, firmware 4.46.23836,
ARMv7 and kernel 4.9.77. Unknown profiles are blocked. Release 0.1.0 is accepted by the owner using prior functional testing. A production
verification key is configured. The newly signed archive was not independently
retested on a reader; see [the acceptance record](releases/0.1.0-acceptance.json).

An attended development sequence has exercised installation, enrolment, managed
updates and signed startup verification on this profile. Sync after restart over
another internet connection was reported during that sequence. This is not an
acceptance record for a clean installation of the final public package.

## Required evidence

Record the exact release and archive digests, model, firmware, browser and host OS.
Keep private serials and credentials out of evidence intended for publication.
Verify these components separately:

- Initial USB backup and privileged-settings recovery.
- Folder exclusions and absence of installer files from My Books.
- Clean root bootstrap, immutable payload and device receipt pinning.
- Enrolment, intended tag, healthy status and actual Calibre-Web sync.
- Startup after a full reboot and sync over a different internet connection.
- USB interruption, power loss, exhausted storage and recovery/rollback paths.
- Existing managed-install update and preservation of identity and data.

Native host tests, browser fixtures and successful client execution each prove a
limited surface. None substitutes for the remaining physical tests. Other models,
firmware versions, Windows/Linux filesystem behaviour and Kobo firmware-update
survival require their own evidence. Do not promote a profile by editing a UI flag.
