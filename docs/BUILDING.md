# Building and checks

Use Node.js 20+, Python 3.11+ and the checksum-pinned Go SDK prepared by
`tools/prepare_toolchain.py`. The application has no production npm dependencies.
Vendor archives are cached locally and their expected hashes are in device lock
files. Host builds never execute ARM vendor binaries.

```sh
python3 tools/prepare_toolchain.py --download
npm test
python3 tools/build.py --download
python3 tools/prepare_sources.py --download
```

The builder refuses to overwrite an existing release directory. Select a new
output for each candidate. A signed build takes an external private key and an
explicit public trust list. Keep that key outside source, cache exports and the
web root. Production keys and exact hardware evidence must be configured before
an installable release can be published.

`prepare_sources.py` collects matching Debian source and notices for the pinned
firewall packages. Keep corresponding sources with distributed binaries and verify
all transitive licensing requirements. The Tailscale upstream reference and Go
runtime notice are also retained. Hash pinning establishes content identity,
not current security maintenance.

## Formatting and comments

JavaScript uses Prettier 3.6.2 and the checked-in configuration. Python uses Ruff
0.15.15 formatting; Go uses the pinned SDK's gofmt. Install formatter tooling in
a development environment, never in the browser payload.

```sh
python3 tools/format_source.py --check
```

Function comments should explain purpose, assumptions and consequential behaviour.
Describe why a hardware/safety check exists, how interruption is handled and what
must remain unchanged. Avoid narrating individual assignments or recording a
conversation in source comments. Keep design and compatibility detail in the
maintainer documentation. Header notices must match each component's actual licence.

## Verification

Run tests for the changed modules first. Publication tests exercise path traversal,
symlink refusal, explicit inventories, private-text rejection and clean snapshot
history. Native fixture tests do not execute ARM programs and require their normal
fake-root sentinel. Test output is not hardware acceptance; see
HARDWARE-ACCEPTANCE.md for the physical release boundary.

## Local signed review bundle

`tools/package_review.py` exports the allowlisted source and site, builds a signed
candidate and collector, includes matching dependency sources, and creates ZIPs
and SHA256 inventories. Supply a separate review Ed25519 key and its public trust
JSON. It refuses promoted profiles or configured production keys. It never pushes,
deploys, accesses a reader or activates a production signer.

```sh
python3 tools/package_review.py --output cache/release-review \
  --vendor-cache cache --source-cache cache/sources \
  --review-key /secure/review.pem --review-trust /secure/review-public.json
```

Review candidates remain non-installable. Do not deploy their site ZIP as the
production installer. See [release review](RELEASE-REVIEW.md) for activation steps.
