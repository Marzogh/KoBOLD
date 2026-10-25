import { SHA256, hashFile, hashBytes } from './sha256.js';
import { safePath } from './core.js';
export async function directory(root, path, create = false) {
  let h = root;
  for (const part of safePath(path).split('/'))
    h = await h.getDirectoryHandle(part, { create });
  return h;
}
export async function fileHandle(root, path, create = false) {
  const parts = safePath(path).split('/'),
    name = parts.pop();
  const dir = parts.length ? await directory(root, parts.join('/'), create) : root;
  return dir.getFileHandle(name, { create });
}
export async function readText(root, path) {
  return (await (await fileHandle(root, path)).getFile()).text();
}
export async function exists(root, path) {
  try {
    await fileHandle(root, path);
    return true;
  } catch (e) {
    if (e.name === 'NotFoundError') return false;
    throw e;
  }
}
/** Write bytes and read them back; browser verification does not imply filesystem fsync. */
export async function writeVerified(root, path, bytes, { exclusive = false } = {}) {
  if (exclusive && (await exists(root, path)))
    throw Error('Refusing to overwrite ' + path);
  const handle = await fileHandle(root, path, true),
    writer = await handle.createWritable();
  try {
    await writer.write(bytes);
    await writer.close();
  } catch (e) {
    await writer.abort().catch(() => {});
    throw e;
  }
  const wanted = hashBytes(
    typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes,
  );
  if ((await hashFile(await handle.getFile())) !== wanted)
    throw Error('Write verification failed: ' + path);
  return wanted;
}
export function fileOperationError(error, operation, path = '') {
  if (error.name === 'AbortError' || error.name === 'BackupError') return error;
  const wrapped = new Error(
    operation + (path ? ' · ' + path : '') + ': ' + error.message,
    { cause: error },
  );
  wrapped.name = 'BackupError';
  wrapped.operation = operation;
  wrapped.path = path;
  wrapped.code = error.name;
  return wrapped;
}
export const MACOS_VOLUME_FOLDERS = new Set([
  '.Spotlight-V100',
  '.fseventsd',
  '.Trashes',
  '.TemporaryItems',
]);
export const isVolumeMetadata = (name) =>
  MACOS_VOLUME_FOLDERS.has(name) ||
  /^(?:\$RECYCLE\.BIN|System Volume Information)$/i.test(name) ||
  /^\.Trash(?:-\d+)?$/.test(name);
export async function inventory(
  root,
  prefix = '',
  onProgress = () => {},
  onExclude = () => {},
) {
  const records = [];
  try {
    for await (const [name, h] of root.entries()) {
      const path = prefix + name;
      safePath(path);
      if (prefix === '' && h.kind === 'directory' && isVolumeMetadata(name)) {
        await onExclude({
          path,
          reason: 'Operating-system-managed volume folder',
        });
        continue;
      }
      if (h.kind === 'directory')
        records.push(...(await inventory(h, path + '/', onProgress, onExclude)));
      else {
        try {
          const f = await h.getFile();
          records.push({ path, size: f.size, modified: f.lastModified });
          await onProgress(records.at(-1));
        } catch (error) {
          throw fileOperationError(error, 'Read file information', path);
        }
      }
    }
  } catch (error) {
    throw fileOperationError(error, 'Read folder', prefix || root.name);
  }
  return records.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export async function separateLocations(reader, backup) {
  if (
    (await reader.isSameEntry(backup)) ||
    (await reader.resolve(backup)) !== null ||
    (await backup.resolve(reader)) !== null
  )
    throw Error('Choose a backup directory separate from the Kobo volume');
}
async function hashWithProgress(file, onProgress) {
  const hash = new SHA256();
  let bytes = 0;
  await onProgress(0);
  for await (const chunk of file.stream()) {
    hash.update(chunk);
    bytes += chunk.length;
    await onProgress(bytes);
  }
  return hash.digest();
}
export async function copyVerified(
  source,
  target,
  path,
  onProgress = () => {},
  { destination = path } = {},
) {
  let operation = 'Read reader file',
    writer,
    stream;
  try {
    const file = await (await fileHandle(source, path)).getFile();
    operation = 'Create backup file';
    const handle = await fileHandle(target, destination, true);
    operation = 'Open backup file for writing';
    writer = await handle.createWritable();
    const hash = new SHA256();
    let count = 0;
    stream = file.stream().getReader();
    await onProgress({ phase: 'copying', bytes: 0, size: file.size });
    while (true) {
      operation = 'Read reader file';
      const { done, value } = await stream.read();
      if (done) break;
      hash.update(value);
      operation = 'Write backup file';
      await writer.write(value);
      count += value.length;
      await onProgress({ phase: 'copying', bytes: count, size: file.size });
    }
    operation = 'Finish writing backup file';
    await writer.close();
    writer = null;
    const sha256 = hash.digest();
    operation = 'Verify backup file';
    if (
      (await hashWithProgress(await handle.getFile(), (bytes) =>
        onProgress({ phase: 'verifying-backup', bytes, size: file.size }),
      )) !== sha256
    )
      throw Error('The copied file does not match the reader.');
    operation = 'Recheck reader file';
    if (
      (await hashWithProgress(
        await (await fileHandle(source, path)).getFile(),
        (bytes) => onProgress({ phase: 'verifying-reader', bytes, size: file.size }),
      )) !== sha256
    )
      throw Error('The reader file changed during backup. Reconnect and try again.');
    return { path, size: file.size, sha256 };
  } catch (error) {
    if (writer) await writer.abort().catch(() => {});
    throw fileOperationError(error, operation, path);
  } finally {
    if (stream) stream.releaseLock();
  }
}
/** Create an immutable snapshot and verify copied or reused files before completion. */
export async function backupReader(
  reader,
  backup,
  onProgress = () => {},
  { previous = null } = {},
) {
  let operation = 'Check backup folder',
    path = backup.name;
  const name = 'kobold-' + crypto.randomUUID();
  let highWater = 0;
  const emit = async (event) => {
    if (Number.isFinite(event.fraction)) {
      event.fraction = Math.max(highWater, event.fraction);
      highWater = event.fraction;
    }
    return onProgress({ backupName: name, ...event });
  };
  try {
    await emit({ phase: 'preparing', fraction: null, completedFiles: 0 });
    await separateLocations(reader, backup);
    if (await exists(backup, 'manifest.json'))
      throw Error('Select the parent backup folder to create an incremental backup.');
    // Detect an unwritable destination before attempting the full copy.
    const probe = '.passage-write-check-' + crypto.randomUUID();
    path = probe;
    try {
      await writeVerified(backup, probe, 'backup write check', {
        exclusive: true,
      });
      operation = 'Remove backup folder check';
      await backup.removeEntry(probe);
    } catch (error) {
      throw fileOperationError(error, operation, path);
    }
    const { discoverBackups, backupSnapshot } = await import('./backup-store.js');
    if (!previous)
      previous = (await discoverBackups(reader, backup)).matches[0] ?? null;
    if (previous && !previous.root && previous.name !== backup.name)
      previous.root = backup;
    let scanned = 0;
    const excluded = [];
    operation = 'Read reader folders';
    path = reader.name;
    const before = await inventory(
      reader,
      '',
      async (record) => {
        scanned++;
        await emit({
          phase: 'scanning',
          path: record.path,
          scannedFiles: scanned,
          fraction: null,
          completedFiles: 0,
        });
      },
      (entry) => excluded.push(entry),
    );
    const totalFiles = before.length,
      totalBytes = before.reduce((a, x) => a + x.size, 0),
      totalWork = before.reduce((a, x) => a + Math.max(1, x.size) * 3, 0);
    operation = 'Create backup folder';
    path = name;
    try {
      await backup.getDirectoryHandle(name);
      throw Error('Backup directory already exists');
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
    const out = await backup.getDirectoryHandle(name, { create: true }),
      snapshot = await out.getDirectoryHandle('reader', { create: true });
    operation = 'Mark backup incomplete';
    path = name + '/INCOMPLETE.json';
    await writeVerified(
      out,
      'INCOMPLETE.json',
      JSON.stringify({
        status: 'incomplete',
        created: new Date().toISOString(),
      }),
      { exclusive: true },
    );
    const entries = [];
    let copiedBytes = 0,
      work = 0,
      reusedFiles = 0;
    const oldEntries = new Map(
      (previous?.manifest.entries ?? []).map((e) => [e.path, e]),
    );
    for (const record of before) {
      const weight = Math.max(1, record.size),
        old = oldEntries.get(record.path);
      if (old && old.size === record.size) {
        operation = 'Check existing reader file';
        path = record.path;
        const digest = await hashWithProgress(
          await (await fileHandle(reader, record.path)).getFile(),
          (bytes) =>
            emit({
              phase: 'checking-existing',
              path: record.path,
              completedFiles: entries.length,
              totalFiles,
              totalBytes,
              fileBytes: bytes,
              fileSize: record.size,
              copiedBytes,
              fraction: totalWork ? (0.95 * (work + bytes)) / totalWork : 0,
            }),
        );
        if (digest === old.sha256) {
          let intact = false;
          try {
            intact =
              (await hashWithProgress(
                await (await fileHandle(previous.snapshot, record.path)).getFile(),
                (bytes) =>
                  emit({
                    phase: 'verifying-backup',
                    path: record.path,
                    completedFiles: entries.length,
                    totalFiles,
                    totalBytes,
                    fileBytes: bytes,
                    fileSize: record.size,
                    copiedBytes,
                    fraction: totalWork
                      ? (0.95 * (work + weight + bytes)) / totalWork
                      : 0,
                  }),
              )) === digest;
          } catch (error) {
            if (error.name === 'AbortError') throw error;
          }
          if (intact) {
            operation = 'Recheck reader file';
            if (
              (await hashWithProgress(
                await (await fileHandle(reader, record.path)).getFile(),
                (bytes) =>
                  emit({
                    phase: 'verifying-reader',
                    path: record.path,
                    completedFiles: entries.length,
                    totalFiles,
                    totalBytes,
                    fileBytes: bytes,
                    fileSize: record.size,
                    copiedBytes,
                    fraction: totalWork
                      ? (0.95 * (work + weight * 2 + bytes)) / totalWork
                      : 0,
                  }),
              )) !== digest
            )
              throw Error('Reader changed during backup. Try again.');
            entries.push({
              path: record.path,
              size: record.size,
              sha256: digest,
              storedIn: old.storedIn ?? previous.name,
            });
            reusedFiles++;
            work += weight * 3;
            await emit({
              phase: 'file-complete',
              path: record.path,
              completedFiles: entries.length,
              totalFiles,
              totalBytes,
              copiedBytes,
              reusedFiles,
              fraction: totalWork ? (0.95 * work) / totalWork : 0,
            });
            continue;
          }
        }
        // Mismatched/corrupt earlier data is repaired by copying the reader,
        // never by rewriting a previous backup or trusting matching timestamps.
      }
      entries.push(
        await copyVerified(reader, snapshot, record.path, async (event) => {
          const phaseIndex = {
            copying: 0,
            'verifying-backup': 1,
            'verifying-reader': 2,
          }[event.phase];
          await emit({
            phase: event.phase,
            path: record.path,
            completedFiles: entries.length,
            totalFiles,
            totalBytes,
            fileBytes: event.bytes,
            fileSize: record.size,
            copiedBytes: copiedBytes + (phaseIndex === 0 ? event.bytes : record.size),
            fraction: totalWork
              ? (0.95 * (work + phaseIndex * weight + event.bytes)) / totalWork
              : 0,
          });
        }),
      );
      copiedBytes += record.size;
      work += weight * 3;
      await emit({
        phase: 'file-complete',
        path: record.path,
        completedFiles: entries.length,
        totalFiles,
        totalBytes,
        copiedBytes,
        fraction: totalWork ? (0.95 * work) / totalWork : 0,
      });
    }
    operation = 'Recheck reader folders';
    path = reader.name;
    let checked = 0;
    await emit({
      phase: 'checking-reader',
      completedFiles: totalFiles,
      totalFiles,
      totalBytes,
      copiedBytes,
      fraction: 0.95,
    });
    const after = await inventory(reader, '', async (record) => {
      checked++;
      await emit({
        phase: 'checking-reader',
        path: record.path,
        completedFiles: totalFiles,
        totalFiles,
        totalBytes,
        copiedBytes,
        fraction: 0.95 + 0.03 * Math.min(checked / Math.max(totalFiles, 1), 1),
      });
    });
    if (JSON.stringify(after) !== JSON.stringify(before))
      throw Error(
        'Reader inventory changed during backup; backup remains marked incomplete',
      );
    const manifest = {
      format: 2,
      generation: (previous?.manifest.generation ?? 0) + 1,
      status: 'verified',
      created: new Date().toISOString(),
      entries,
      excluded,
      reusedFiles,
      copiedFiles: entries.length - reusedFiles,
      copiedBytes,
    };
    operation = 'Save backup summary';
    path = name + '/manifest.json';
    await emit({
      phase: 'finishing',
      completedFiles: totalFiles,
      totalFiles,
      totalBytes,
      copiedBytes,
      fraction: 0.99,
    });
    await writeVerified(
      out,
      'manifest.json',
      JSON.stringify(manifest, null, 2) + '\n',
      { exclusive: true },
    );
    operation = 'Mark backup complete';
    path = name + '/INCOMPLETE.json';
    await out.removeEntry('INCOMPLETE.json');
    await emit({
      phase: 'complete',
      completedFiles: totalFiles,
      totalFiles,
      totalBytes,
      copiedBytes,
      fraction: 1,
      excluded,
    });
    return {
      directory: out,
      snapshot: await backupSnapshot(out, manifest, backup),
      manifest,
      name,
      root: backup,
    };
  } catch (error) {
    const failure = fileOperationError(error, operation, path);
    failure.backupName = name;
    throw failure;
  }
}
/** Resolve and hash every manifest entry without modifying the saved snapshot. */
export async function verifyBackup(snapshot, manifest, onProgress = () => {}) {
  if (
    manifest.status !== 'verified' ||
    !Array.isArray(manifest.entries) ||
    !manifest.entries.length
  )
    throw Error('No verified backup manifest');
  const seen = new Set();
  for (const entry of manifest.entries) {
    safePath(entry.path);
    if (
      seen.has(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw Error('Invalid backup manifest entry');
    seen.add(entry.path);
    const f = await (await fileHandle(snapshot, entry.path)).getFile();
    if (
      f.size !== entry.size ||
      (await hashWithProgress(f, (bytes) =>
        onProgress({
          phase: 'verifying-backup',
          path: entry.path,
          fileBytes: bytes,
          fileSize: entry.size,
          totalFiles: manifest.entries.length,
          completedFiles: seen.size - 1,
          fraction: null,
        }),
      )) !== entry.sha256
    )
      throw Error('Backup does not match its manifest: ' + entry.path);
  }
  return true;
}
export async function unchanged(reader, manifest, onProgress = () => {}) {
  let scannedFiles = 0;
  await onProgress({ phase: 'scanning', scannedFiles, fraction: null });
  const records = await inventory(reader, '', async (entry) => {
    scannedFiles++;
    await onProgress({
      phase: 'scanning',
      path: entry.path,
      scannedFiles,
      fraction: null,
    });
  });
  if (
    records.length !== manifest.entries.length ||
    records.some(
      (r) => !manifest.entries.some((e) => e.path === r.path && e.size === r.size),
    )
  )
    throw Error(
      'Reader changed since backup. Make a fresh incremental backup before installation.',
    );
  for (const [i, entry] of manifest.entries.entries()) {
    const f = await (await fileHandle(reader, entry.path)).getFile();
    if (
      f.size !== entry.size ||
      (await hashWithProgress(f, (bytes) =>
        onProgress({
          phase: 'verifying-reader',
          path: entry.path,
          fileBytes: bytes,
          fileSize: entry.size,
          totalFiles: manifest.entries.length,
          completedFiles: i,
          fraction: null,
        }),
      )) !== entry.sha256
    )
      throw Error(
        'Reader changed since backup. Make a fresh incremental backup before installation.',
      );
  }
  return true;
}
