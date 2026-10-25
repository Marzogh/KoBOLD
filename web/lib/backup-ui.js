export function browserSupport(scope) {
  const fileAccess =
    scope.isSecureContext === true &&
    typeof scope.showDirectoryPicker === 'function' &&
    typeof scope.FileSystemFileHandle?.prototype?.createWritable === 'function';
  return { fileAccess };
}
export const phaseLabels = {
  'checking-existing': 'Checking existing file',
  preparing: 'Checking backup folder',
  scanning: 'Reading Kobo folders',
  copying: 'Copying file',
  'verifying-backup': 'Checking copied file',
  'verifying-reader': 'Rechecking reader file',
  'file-complete': 'File checked',
  'checking-reader': 'Checking reader folders',
  finishing: 'Saving backup summary',
  complete: 'Backup completed',
};
export function backupProgress(event) {
  const fraction = Number.isFinite(event.fraction)
    ? Math.max(0, Math.min(1, event.fraction))
    : null;
  const bytes = (n) =>
    n < 1024
      ? n + ' B'
      : n < 1048576
        ? (n / 1024).toFixed(1) + ' KiB'
        : (n / 1048576).toFixed(1) + ' MiB';
  return {
    phase: phaseLabels[event.phase] ?? 'Backing up',
    fraction,
    path: event.path ?? '',
    files:
      event.totalFiles === undefined
        ? event.scannedFiles === undefined
          ? ''
          : event.scannedFiles + ' files found'
        : event.completedFiles + ' of ' + event.totalFiles + ' files checked',
    bytes:
      event.totalBytes === undefined
        ? ''
        : bytes(event.copiedBytes ?? 0) +
          ' copied · ' +
          bytes(event.totalBytes) +
          ' on Kobo',
    fileProgress:
      event.fileSize === undefined
        ? ''
        : bytes(event.fileBytes ?? 0) + ' of ' + bytes(event.fileSize),
    location: event.backupName ?? '',
  };
}
export function backupFailure(error) {
  const code = error.code ?? error.name;
  const hints = {
    NotAllowedError: 'Allow access to the backup folder, then try again.',
    SecurityError: 'Choose another writable backup folder, then try again.',
    InvalidModificationError:
      'The browser could not modify this file or folder. Try a different writable backup folder.',
    QuotaExceededError: 'Free some space or choose another backup folder.',
    NotFoundError: 'Keep the Kobo connected and select the folders again.',
    NotReadableError: 'Close other applications using these files, then try again.',
  };
  return {
    title: code === 'AbortError' ? 'Backup cancelled' : 'Backup failed',
    operation: error.operation ?? 'Backup',
    path: error.path ?? '',
    reason:
      (code === 'InvalidModificationError' &&
      /^(Read|Recheck)/.test(error.operation ?? '')
        ? 'The browser could not read this Kobo file or folder. Check the file path below and reconnect the reader before trying again.'
        : hints[code]) ??
      error.cause?.message ??
      error.message,
    details: error.message,
    location: error.backupName ?? '',
  };
}
