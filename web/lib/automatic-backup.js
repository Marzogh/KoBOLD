import { checkBackup, requireSystemBackup, systemBackupPath } from './backup-store.js';
import { backupReader, copyVerified } from './storage.js';
export async function updateBackup(reader, root, current, onProgress = () => {}) {
  if (!root) throw Error('Select the authorised backup folder to continue.');
  if (current && !current.skipped) {
    const checked = await checkBackup(reader, current, { onProgress });
    if (checked.usable) return current;
  }
  if (current?.skipped) throw Error('A full backup is required for this trial.');
  const next = await backupReader(reader, root, onProgress, {
    previous: current,
  });
  if (current) {
    let expected;
    try {
      expected = await requireSystemBackup(reader, current);
    } catch {}
    if (expected) {
      await copyVerified(
        current.directory,
        next.directory,
        'privileged/' + (await systemBackupPath(reader)),
        onProgress,
      );
      next.systemHash = await requireSystemBackup(reader, next);
    }
  }
  return next;
}
