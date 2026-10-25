import { requireManagedProof } from './provenance.js';
import { readText, writeVerified } from './storage.js';
const config = '.kobo/Kobo/Kobo eReader.conf';
// QSettings stores each regexp backslash doubled in the INI file.
const pattern = '(?:\\\\.adds/(?:kobold|kobold-preflight|kobold-connect)(?:/.*)?)';
export function installerExclusionPresent(text) {
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\[([^\]]+)\]\s*$/);
    if (header) section = header[1];
    else if (
      section === 'FeatureSettings' &&
      /^ExcludeSyncFolders\s*=/.test(line) &&
      line.slice(line.indexOf('=') + 1).includes(pattern)
    )
      return true;
  }
  return false;
}
export function excludeInstallerFolders(text) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n',
    lines = text.split(/\r?\n/);
  let section = '',
    header = -1,
    key = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\[([^\]]+)\]\s*$/);
    if (m) {
      section = m[1];
      if (section === 'FeatureSettings') {
        if (header !== -1)
          throw Error('Duplicate FeatureSettings section; no settings changed.');
        header = i;
      }
    } else if (
      section === 'FeatureSettings' &&
      /^ExcludeSyncFolders\s*=/.test(lines[i])
    ) {
      if (key !== -1)
        throw Error('Duplicate folder exclusion setting; no settings changed.');
      key = i;
    }
  }
  if (key !== -1) {
    const original = lines[key].slice(lines[key].indexOf('=') + 1);
    if (original.includes(pattern)) return text;
    if (/["\r\n]/.test(original))
      throw Error('Quoted folder exclusion needs review; no settings changed.');
    lines[key] =
      'ExcludeSyncFolders=' + (original ? '(?:' + original + ')|' : '') + pattern;
  } else if (header !== -1)
    lines.splice(header + 1, 0, 'ExcludeSyncFolders=' + pattern);
  else {
    if (lines.at(-1) !== '') lines.push('');
    lines.push('[FeatureSettings]', 'ExcludeSyncFolders=' + pattern, '');
  }
  return lines.join(nl);
}
export async function protectInstallerFolders(reader, backup, proof = null) {
  const before = await readText(reader, config),
    after = excludeInstallerFolders(before);
  if (after === before) return false;
  // Changing exclusions after indexing can make Nickel delete indexed payload files.
  for (const name of ['kobold', 'kobold-preflight', 'kobold-connect']) {
    let owned;
    try {
      owned = await (await reader.getDirectoryHandle('.adds')).getDirectoryHandle(name);
    } catch (error) {
      if (error.name === 'NotFoundError') continue;
      throw error;
    }
    for await (const entry of owned.entries()) {
      if (proof) {
        requireManagedProof(proof, reader);
        break;
      }
      throw Error(
        'Installer files already exist. Changing library exclusions requires a safe migration; no settings changed.',
      );
    }
  }
  const destination = backup.root ?? backup.directory;
  if (!destination)
    throw Error('A backup folder is required before changing folder exclusions.');
  await writeVerified(
    destination,
    'settings-before-exclusion/' + crypto.randomUUID() + '.conf',
    before,
    { exclusive: true },
  );
  await writeVerified(reader, config, after);
  return true;
}
