# Security model

KoBOLD is a static application with no hosted backend, telemetry, remote shell
bridge or third-party runtime scripts. Content Security Policy limits runtime
resources to the hosting origin. Tailscale authorisation uses an explicit external
link. Folder access requires the user's browser permission.

## Trust boundaries

A compromised hosting origin can replace the application and abuse granted folder
access. Same-origin hashes do not protect against that compromise. Use reviewed
releases and revoke access when finished. The application cannot enforce backup
encryption or guarantee deletion of browser session data at window close.

Signed release metadata authenticates its package contents. Reader receipts bind
requests and installed files to a device key stored outside USB storage. First-use
pinning assumes a trusted physical installation handoff. It is not hardware
attestation: an attacker with root access can replace code, extract keys or clone
state. See INSTALLATION-PROVENANCE.md.

Input validation, fixed action names and scoped paths constrain device operations.
Symlinks, unknown fields, replayed challenges and modified signed payloads are
rejected. Host-created sidecars are ignored only under bounded metadata rules;
those exceptions do not authorise missing executables or altered libraries.

## Network exposure

The client uses accept-dns=false, accept-routes=false, ssh=false and shields-up=true.
It advertises no routes and is not an exit node. Tailscale policy defines which
server addresses and ports the reader can reach. Existing broad grants are
additive; deny tests are policy assertions, not firewall deny rules.

A stolen enrolled reader can use its granted access until revoked. Allowing a
server port does not restrict HTTP paths on that port. Server account permissions
and application isolation remain separate responsibilities. The installer does
not require public exposure of Calibre-Web or other household services.

## Distribution and dependencies

Trust keys and exact hardware acceptance are required before installation can be
promoted. Private signing keys stay outside source and release bundles. Publication
uses explicit inventories and rejects private records; see PUBLICATION.md.

Pinned legacy firewall libraries are not security-maintained merely because their
hashes are known. Private runtime paths avoid system ABI replacement but do not
remove vulnerabilities in the bundled code. Review dependency upgrades and the
matching source/licence bundle before distribution.

Do not publish backups, reader serials, policies, tokens, private keys or sign-in
URLs. Security reports should contain a redacted description and affected version,
without live credentials or library contents. General bug reports can use https://github.com/Marzogh/KoBOLD/issues. Do not post
credentials or sensitive vulnerability details publicly; a private security-report
channel has not yet been configured.
