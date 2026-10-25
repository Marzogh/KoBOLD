import {
  requireSignedRelease,
  verifyEnvelope,
  inheritedRelease,
} from './provenance.js';
import { discoverBackups } from './backup-store.js';
import { readText, exists, fileHandle } from './storage.js';
import { hashFile } from './sha256.js';
import { installerExclusionPresent } from './library-exclusion.js';
const base = '.adds/kobold/releases/0.1.0/';
async function exclusion(source) {
  try {
    return {
      ownedRulePresent: installerExclusionPresent(
        await readText(source, '.kobo/Kobo/Kobo eReader.conf'),
      ),
    };
  } catch {
    return { ownedRulePresent: null };
  }
}
async function observation(source, path) {
  try {
    if (!(await exists(source, base + path))) return { present: false };
    return {
      present: true,
      sha256: await hashFile(await (await fileHandle(source, base + path)).getFile()),
    };
  } catch {
    return { present: null, readable: false };
  }
}
// Exports only signed installer paths and their observations, never library names,
// configuration contents, account values, serial numbers or private trust records.
export async function payloadHistory(
  reader,
  backupRoot,
  release,
  paths,
  progress = () => {},
) {
  requireSignedRelease(release);
  const allowed = new Set(release.files.map((f) => f.path));
  if (paths.length > 32 || paths.some((p) => !allowed.has(p)))
    throw Error('Choose at most 32 signed installer paths.');
  const { matches, issues } = await discoverBackups(reader, backupRoot),
    snapshots = [];
  for (const b of [...matches].reverse()) {
    progress('Checking backup generation ' + (b.manifest.generation ?? 1));
    const files = [];
    for (const path of paths)
      files.push({ path, ...(await observation(b.snapshot, path)) });
    snapshots.push({
      created: b.manifest.created,
      generation: b.manifest.generation ?? 1,
      scanExclusion: await exclusion(b.snapshot),
      files,
    });
  }
  const checkpoints = [];
  try {
    const checks = await backupRoot.getDirectoryHandle('installation-checks');
    for await (const [name, folder] of checks.entries()) {
      if (folder.kind !== 'directory' || !/^([a-f0-9]{32})$/.test(name)) continue;
      try {
        const check = JSON.parse(await readText(folder, 'before-eject.json'));
        if (
          check.phase !== 'browser-before-eject' ||
          !Array.isArray(check.files) ||
          ![
            release.installationDescriptorSha256,
            release.continuation?.previous?.installationDescriptorSha256,
          ].includes(check.descriptor)
        )
          continue;
        checkpoints.push({
          source: 'unsigned-browser-readback',
          observedAt: Number.isFinite(Date.parse(check.observedAt))
            ? new Date(check.observedAt).toISOString()
            : null,
          files: paths.map((path) => ({
            path,
            sha256:
              check.files
                .find((f) => f.path === path)
                ?.sha256?.match(/^[a-f0-9]{64}$/)?.[0] ?? null,
          })),
        });
      } catch {}
    }
  } catch {}
  const current = [];
  for (const path of paths)
    current.push({ path, ...(await observation(reader, path)) });
  const inspection = { verified: false };
  try {
    const identity = await hashFile(
      await (await fileHandle(reader, '.kobo/version')).getFile(),
    );
    const store = await (
      await backupRoot.getDirectoryHandle('kobold-installations')
    ).getDirectoryHandle(identity);
    const pin = JSON.parse(await readText(store, 'trust.json'));
    const id = (await readText(reader, '.adds/kobold/last-result.txt')).trim();
    if (!/^[a-f0-9]{32}$/.test(id)) throw Error('Invalid report');
    const { value: r, digest } = await verifyEnvelope(
      JSON.parse(
        await readText(reader, '.adds/kobold/reports/' + id + '/installation.json'),
      ),
      { [pin.publicKey]: pin.publicKey },
    );
    const accepted = release.continuation?.previous
      ? inheritedRelease(release, release.continuation.previous)
      : release;
    if (
      digest !== pin.digest ||
      pin.identity !== identity ||
      r.identity !== identity ||
      r.release !== accepted.installationDescriptorSha256 ||
      r.installationId !== pin.installationId
    )
      throw Error('Unpinned receipt');
    inspection.verified = true;
    inspection.status = r.status;
    inspection.files = paths.map((path) => ({
      path,
      checkedSignedHash:
        !!accepted.files.find((f) => f.path === path)?.sha256 &&
        r.files?.['/mnt/onboard/' + base + path] ===
          accepted.files.find((f) => f.path === path)?.sha256,
    }));
  } catch {
    inspection.note = 'A matching saved inspection receipt could not be verified.';
  }
  return {
    format: 1,
    current: { scanExclusion: await exclusion(reader), files: current },
    inspection,
    checkpoints,
    snapshots,
    unavailableBackupCount: issues.length,
  };
}
