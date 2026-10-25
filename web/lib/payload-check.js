import { requireSignedRelease } from './provenance.js';
import { fileHandle, writeVerified } from './storage.js';
import { hashFile } from './sha256.js';
import { auditPayload } from './payload-audit.js';
const base = '.adds/kobold/releases/0.1.0/';
// This is a browser readback checkpoint, not a native durability or fsync claim.
export async function checkStagedPayload(reader, release, progress = () => {}) {
  requireSignedRelease(release);
  const audit = await auditPayload(reader, release);
  if (audit.missing.length)
    throw Error(
      'Installer files are missing before eject: ' + audit.missing.join(', '),
    );
  if (audit.unexpected.length)
    throw Error(
      'Unexpected installer files before eject: ' + audit.unexpected.join(', '),
    );
  const files = [];
  for (const f of release.files) {
    progress('Checking ' + f.path);
    const hash = await hashFile(
      await (await fileHandle(reader, base + f.path)).getFile(),
    );
    if (hash !== f.sha256)
      throw Error('Installer file changed before eject: ' + f.path);
    files.push({ path: f.path, sha256: hash });
  }
  return {
    format: 1,
    phase: 'browser-before-eject',
    observedAt: new Date().toISOString(),
    descriptor: release.installationDescriptorSha256,
    files,
  };
}
export async function savePayloadCheck(backup, nonce, result) {
  if (!/^[a-f0-9]{32}$/.test(nonce) || result.phase !== 'browser-before-eject')
    throw Error('Invalid payload checkpoint.');
  const root = backup.root ?? backup.directory;
  if (!root) throw Error('Choose a backup folder before preparing installation.');
  await writeVerified(
    root,
    'installation-checks/' + nonce + '/before-eject.json',
    JSON.stringify(result, null, 2) + '\n',
    { exclusive: true },
  );
}
