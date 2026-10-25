import { requireSignedRelease } from './provenance.js';
export function inspectOnly(release) {
  return (
    ['attended-trial', 'trial-preview'].includes(release?.channel) &&
    release.trial?.purpose === 'inspect-only'
  );
}
export function connectionCapable(release) {
  return (
    release?.channel === 'connection-trial' ||
    (release?.channel === 'attended-trial' &&
      release.trial?.purpose === 'install-and-connect') ||
    (release?.channel === 'tested' &&
      !!release.profile?.bootstrapAccepted &&
      !!release.profile?.bootstrapEvidence)
  );
}
export function connectionInstallation(release, trust) {
  try {
    requireSignedRelease(release);
  } catch {
    return false;
  }
  return (
    connectionCapable(release) &&
    trust?.descriptor === release.installationDescriptorSha256 &&
    trust.status !== 'removed'
  );
}
