# KoBOLD typography

KoBOLD Display v2 supplies the decorative wordmark. KoBOLD Story Serif supplies
Regular and Medium headings; it is adapted from Noto Serif Display. Forms,
buttons, instructions and diagnostics use the system sans serif.

Original supplied build scripts and lettering artwork are preserved in display/
and story/. Their original authorship and legal notices remain intact. The
upstream font input is pinned by commit, URL and SHA-256 in upstream.json.
OFL-NotoSerifDisplay.txt contains the original copyright and full SIL OFL 1.1.
Distributed Story Serif font files retain these terms and use a distinct family
name. Display v2's supplied copyright attribution is retained in its metadata.

Install requirements.lock into an isolated Python environment. Obtain the exact
upstream files listed in upstream.json, then run from the repository root:

```sh
python tools/prepare_brand.py --font-source /path/to/pinned-font-inputs
```

The tool checks every upstream hash, instantiates width 100 at weights 400 and
500, runs the supplied builders without their optional system-specific previews,
and produces local WOFF2 and artwork derivatives under web/assets. No remote
fonts or image services are used by the application. Generated hashes are
recorded in web/assets/SHA256.json.

Use the ss01 leaf-O alternate only for the KoBOLD wordmark. Display v2 is a
limited display face; do not use it for instructions or arbitrary user text.
Font loading failure falls back to the named local serif families.
