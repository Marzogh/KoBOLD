import { managedInstallation } from './provenance.js';
import { assertBackupChoice, requireSystemBackup } from './backup-store.js';
import { requireScanReady } from './scan-protection.js';
import { asset } from './installer.js';
import { auditPayload } from './payload-audit.js';
import { exists, writeVerified } from './storage.js';
export async function repairManagedPayload(
  reader,
  backup,
  release,
  { fetcher = fetch, progress = () => {} } = {},
) {
  await requireScanReady(reader, backup);
  await assertBackupChoice(reader, backup, { current: true });
  await requireSystemBackup(reader, backup);
  if (
    (await exists(reader, '.kobo/KoboRoot.tgz')) ||
    (await exists(reader, '.adds/kobold/request.txt'))
  )
    throw Error('Complete the queued reader update or job first.');
  const proof = await managedInstallation(reader, backup, release),
    audit = await auditPayload(reader, proof.release);
  if (audit.unexpected.length)
    throw Error('Unexpected installer files require review.');
  const blobs = [];
  for (const path of proof.missing) {
    const f = proof.release.files.find((f) => f.path === path);
    progress('Downloading and verifying ' + path);
    blobs.push([path, await asset({ ...f, url: 'objects/' + f.sha256 }, fetcher)]);
  }
  // Verify every input before the first write. Existing changed files are never overwritten.
  for (const [path, data] of blobs) {
    progress('Restoring and verifying ' + path);
    await writeVerified(reader, '.adds/kobold/releases/0.1.0/' + path, data, {
      exclusive: true,
    });
  }
  await managedInstallation(reader, backup, release);
  return { restored: blobs.map(([path]) => path) };
}
