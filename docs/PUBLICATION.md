# Public source and static-site packaging

`publication/files.json` is the explicit file inventory. Files not listed are not
copied, even when tracked by Git. New modules, assets and notices must be reviewed
and added. Source and static-site inventories are separate.

```sh
python3 tools/export_public.py --output cache/public-source --initialise-git
python3 tools/export_public.py --kind site --output cache/public-site
```

Outputs must not already exist. The exporter rejects unsafe paths, symlinks,
missing listed files, private keys, authentication tokens, personal workstation
paths and internal instruction headings. Relative JavaScript imports must resolve
to listed files. Copied files receive a checksum inventory. No export command
creates a remote, pushes commits or publishes a website.

Source export creates a new local Git repository only when explicitly requested.
Its history starts with that snapshot; it does not copy the development repository's
Git directory, branches, tags, messages or author history. Review the new commit's
identity and all included files before creating a public remote.

Private backups, release signers, trial archives, development journals and local
instructions stay outside the inventory. Ignoring a tracked file does not erase
it from history. Do not push all branches or mirror an existing private repository
as a substitute for exporting reviewed source.

The default site export contains only listed application files and assets, with
public verification keys. It is a source preview, not an installable release.
Generated signed release/collector archives require a separate release review;
they are not recursively swept into a public site. The root package builder itself
uses an exact archive member inventory. Keep hardware acceptance, signatures,
corresponding sources and licences intact when preparing a real distribution.

The CI candidate artifact uses this static allowlist plus its explicitly generated
candidate release files. It remains non-installable and is not a Pages deployment.
The public destination is https://github.com/Marzogh/KoBOLD. Repository creation does not enable Pages or a production installer release.

## GitHub Pages preview

The manually triggered `pages.yml` workflow verifies browser logic and publication
boundaries, exports only the static allowlist with `--preview`, and deploys through
the `github-pages` environment. It does not include native binaries, root overlays,
collector archives, signing keys or private development records. The preview
marker disables device actions; backup and policy review remain available. Legacy
standalone update/diagnostic entry pages and the unused legacy app entry are
omitted from preview output.
Source and private signed sites have no marker and keep their normal release gates.

After reviewed source is pushed, enable the repository's Pages source as GitHub
Actions and dispatch this workflow on main. Pushing source alone does not deploy.
Only the deploy job receives pages-write and identity-token permissions; no DNS
or user-site domain changes are needed. KoBOLD inherits the account's existing
Pages custom domain unless a project-specific domain is configured separately.

Installable public releases require approved signatures and exact-artifact acceptance.
See [release review](RELEASE-REVIEW.md). Preview deployment does not change those gates.
