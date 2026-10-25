# Wizard state and UI contracts

The browser adapter owns filesystem permissions, signed device evidence, current
release and pending jobs. The view derives the next action from those facts; visual
progress alone cannot authorise a write.

The sequence is reader/backup, Tailscale settings, folder preparation, system
collection, installation, enrolment/connection, sync address, startup and completion.
USB disconnect/reconnect instructions belong to the action that queued the work.
A prepared package is not a completed device operation. Signed matching results
are required before advancing.

A refresh restores settings and hints without replaying writes. Reselecting a
remounted reader reloads signed status without enumerating the book library.
Diagnostic capture and ordinary status reads must not create jobs or trigger a
full backup check. Writes retain their operation-specific backup preconditions.

Progress uses a bounded bar with phase, current file and counts below it. Each
long-running action reports start, progress and terminal success/failure locally.
Completed actions are disabled while the next relevant action is exposed.

Managed updates retain the enrolled identity and establish signed continuity from
the exact previous release. The public wizard contains no personal installation
import or one-off namespace migration flow.
