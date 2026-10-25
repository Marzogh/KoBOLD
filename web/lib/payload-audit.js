import { hostMetadata } from './host-metadata.js';
import { inventory, directory } from './storage.js';
import { requireSignedRelease, inheritedRelease } from './provenance.js';
// Read-only diagnostic of the reserved application payload, never the library.
// An unexpected file is not declared harmless and is never removed here.
export async function auditPayload(reader, release) {
  requireSignedRelease(release);
  let manifests = [release];
  if (release.continuation?.previous)
    manifests.push(inheritedRelease(release, release.continuation.previous));
  const expected = new Set(manifests.flatMap((m) => m.files.map((f) => f.path)));
  const files = await inventory(
    await directory(reader, '.adds/kobold/releases/0.1.0'),
    'payload/',
  );
  const paths = files.map((f) => f.path.slice(8)),
    metadata = files
      .filter((f) => f.size <= 1024 * 1024 && hostMetadata(f.path.slice(8), expected))
      .map((f) => f.path.slice(8)),
    unexpected = paths.filter((p) => !expected.has(p) && !metadata.includes(p));
  const missing = [...expected].filter((p) => !paths.includes(p)).sort();
  const caseDifferences = missing.flatMap((wanted) =>
    paths
      .filter((p) => p.toLowerCase() === wanted.toLowerCase())
      .map((actual) => ({ expected: wanted, actual })),
  );
  return {
    missing,
    caseDifferences,
    unexpected,
    metadata,
    paths,
    expected: [...expected].sort(),
  };
}
export function auditMessage(audit) {
  const messages = [];
  if (audit.missing.length)
    messages.push(
      'Missing expected files:\n' + audit.missing.map((p) => '• ' + p).join('\n'),
    );
  if (audit.caseDifferences.length)
    messages.push(
      'Filename casing differences:\n' +
        audit.caseDifferences
          .map((p) => '• Expected ' + p.expected + '; found ' + p.actual)
          .join('\n'),
    );
  if (audit.unexpected.length)
    messages.push(
      'Unexpected payload files:\n' + audit.unexpected.map((p) => '• ' + p).join('\n'),
    );
  if (!messages.length)
    messages.push(
      'All expected filenames are present. No unexpected payload files found.',
    );
  if (audit.metadata.length)
    messages.push(
      'Recognised operating-system metadata: ' + audit.metadata.length + ' files.',
    );
  return messages.join('\n\n');
}
