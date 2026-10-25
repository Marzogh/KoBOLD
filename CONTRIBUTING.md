# Contributing

Read the architecture, security, backup and recovery documents before modifying
installation behaviour. Preserve books, settings, databases and enrolled identity.
Changes to trusted paths, action formats or receipt state require explicit migration
and interruption tests. Keep unknown hardware and firmware blocked.

Use readable formatting and short purpose comments. Explain constraints and
recovery behaviour where the code is not self-evident. Do not add local workaround
paths in place of fixing the normal installation/update sequence.

Use synthetic reader data in tests. Do not commit live policies, keys, backups,
serial numbers, sign-in URLs, personal work logs or workstation paths. Keep required
third-party copyright notices and licences intact. Generated source/site snapshots
must pass the explicit publication inventory checks.

Run focused checks for the changed behaviour. Record skipped or unavailable tests
rather than implying success. Hardware evidence is scoped to the exact model,
firmware, artifact and workflow tested; see docs/HARDWARE-ACCEPTANCE.md.
