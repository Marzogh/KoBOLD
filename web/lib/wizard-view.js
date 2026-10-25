// Pure presentation projection. The adapter independently enforces every action.
export const STAGES = ['reader', 'network', 'install', 'connect', 'complete'];
export function wizardView(s) {
  const result = (step, action, label, title, instruction, extra = {}) => ({
    step,
    action,
    label,
    title,
    instruction,
    ...extra,
  });
  if (!s.initialized)
    return result('reader', null, 'Loading', 'Open KoBOLD', 'Reading setup files…');
  if (s.permissionNeeded)
    return result(
      'reader',
      'resume-access',
      'Allow folder access',
      'Reconnect your folders',
      'Allow access to the saved Kobo and backup folders.',
    );
  if (!s.reader)
    return result(
      'reader',
      'select-reader',
      'Choose Kobo folder',
      'Select your Kobo',
      'Connect your Kobo by USB. Select its USB drive, not a folder inside it.',
    );
  if (!s.backupFolder)
    return result(
      'reader',
      'select-backup',
      s.journey === 'new' ? 'Choose backup folder and back up' : 'Choose backup folder',
      'Select a private backup folder',
      'Choose a folder on your computer, separate from the Kobo. Keep earlier backups together.',
    );
  if (s.preview)
    return result(
      'network',
      s.policyConfirmed ? null : 'review-policy',
      s.policyConfirmed ? '' : 'Review proposed policy',
      s.policyConfirmed ? 'Policy review complete' : 'Review Tailscale policy',
      s.policyConfirmed
        ? 'You can copy the policy and export diagnostics. Installation, updates and device status checks are unavailable on this site.'
        : 'Enter your server details and prepare changes to your existing Tailscale policy. This site provides backups and policy review only.',
    );
  if (s.journey === 'recovery')
    return result(
      'recovery',
      'status',
      'Read Kobo status',
      'Recovery',
      'Read the existing result or choose a supported recovery action. Reads do not change the Kobo.',
    );
  if (s.cycle)
    return result(
      s.cycle.step,
      'return',
      'Read and verify result',
      s.cycle.title,
      s.cycle.instructions.join(' '),
      { cycle: true },
    );
  if (s.managedDetected && s.startupVerified && !s.incomplete) {
    return result(
      'complete',
      null,
      '',
      s.error ? 'Latest check needs attention' : 'Your installation is ready',
      s.error
        ? 'An earlier signed result verified automatic startup. The latest check did not complete successfully. Review the error and diagnostics without repeating setup.'
        : 'Automatic startup has a verified signed result. Read status, apply an available supported update or open Recovery without repeating setup.',
      { management: true, existingSummary: true },
    );
  }
  if (s.managedDetected && !s.backupPresent)
    return result(
      'reader',
      'backup',
      'Create a Kobo backup',
      'Back up this installation',
      'No matching backup was found on this computer. Create a backup before continuing. Saved installation trust may still be needed for updates or recovery.',
    );
  if (s.journey === 'managed') {
    if (!s.trust)
      return result(
        'reader',
        'status',
        'Read Kobo status',
        'Check this installation',
        'Read the signed installation result. Your book backup will not be scanned.',
      );
    return result(
      'reader',
      'manage',
      'Continue setup',
      'Your installation',
      'Choose an available update, continue connection setup or open Recovery.',
      { management: true },
    );
  }
  if (!s.active && !s.backupVerified && !s.backupPreviouslyVerified && !s.backupSkipped)
    return result(
      'reader',
      'backup',
      'Create or check backup',
      'Back up your Kobo',
      'Copy new or changed files and check the backup before installation.',
    );
  if (!s.policyConfirmed)
    return result(
      'network',
      'review-policy',
      'Review proposed policy',
      'Configure Tailscale',
      'Enter your server details and prepare changes to your existing policy.',
    );
  if (s.incomplete)
    return result(
      'recovery',
      'status',
      'Read Kobo status',
      'Setup needs attention',
      'Keep USB connected. Read the result and diagnostic log before preparing another action.',
    );
  if (!s.active) {
    if (!s.supported)
      return result(
        'install',
        null,
        'Installation unavailable',
        'Unsupported reader',
        'This model or firmware is not supported for installation.',
      );
    if (!s.releaseAllowsInstall)
      return result(
        'install',
        null,
        'Installation unavailable',
        'Installation unavailable',
        'This signed package does not permit a fresh installation. Backups and existing-installation checks remain available.',
      );
    if (s.scan !== 'ready')
      return result(
        'install',
        'prepare-folders',
        'Prepare library folders',
        'Prepare library folders',
        'Save the folder setting before any installation files are copied. A full restart follows.',
      );
    if (!s.collectionReady && s.collectionPrepared)
      return result(
        'install',
        'resume-collection',
        'Read system collection',
        'Check saved system collection',
        'Read the signed result and verify its saved archive. Do not prepare another collection.',
      );
    if (!s.collectionReady && !s.collectionAvailable)
      return result(
        'install',
        null,
        'Collection unavailable',
        'System collection unavailable',
        'The signed system collection package is unavailable. Do not prepare installation files.',
      );
    if (!s.collectionReady)
      return result(
        'install',
        'prepare-collection',
        'Collect system settings',
        'Save system settings',
        'Prepare system collection, then save and verify the returned backup automatically.',
      );
    return result(
      'install',
      'install',
      'Install Tailscale',
      'Install Tailscale',
      'Copy and verify the installation files. Keep USB connected until preparation finishes.',
    );
  }
  if (!s.systemVerified)
    return result(
      'install',
      'save-system',
      'Save system backup',
      'Save system settings',
      'Save and verify the system backup from the signed installation result.',
    );
  if (!s.policyConfirmed || !s.configured)
    return result(
      'network',
      'review-policy',
      'Review proposed policy',
      'Check your settings',
      'Confirm your server and saved Tailscale policy before changing connection settings.',
    );
  if (!s.connectionHealthy) {
    if (s.signinReady && !s.signinOpened)
      return result(
        'connect',
        'open-signin',
        'Open Tailscale',
        'Authorise your Kobo',
        'Approve the Kobo on Tailscale, then return here to check its connection.',
      );
    return result(
      'connect',
      'authorise',
      s.signinOpened || s.existingEnrollment ? 'Check connection' : 'Get sign-in link',
      'Connect your Kobo',
      s.existingEnrollment
        ? 'Check the retained Tailscale registration before signing in again.'
        : 'Prepare the connection check. You will disconnect and reconnect the Kobo.',
    );
  }
  if (!s.endpointCorrect)
    return result(
      'connect',
      'endpoint',
      'Update sync address',
      'Set the sync address',
      'Back up the current settings and point Kobo sync to your Calibre-Web server.',
    );
  if (!s.syncConfirmed && !s.startupVerified)
    return result(
      'connect',
      'sync-test',
      'Test Kobo sync',
      'Test syncing',
      'Disconnect USB, try syncing on the Kobo, then reconnect and confirm the result.',
    );
  if (!s.startupVerified)
    return result(
      'connect',
      'enable',
      'Enable automatic startup',
      'Enable automatic startup',
      'Prepare automatic startup after your successful sync test. The signed result will be checked after USB return.',
    );
  if (!s.finalConfirmed)
    return result(
      'connect',
      'final-test',
      'Test after restart',
      'Check startup after a restart',
      'Fully restart the Kobo and test syncing on another internet connection.',
    );
  return result(
    'complete',
    null,
    'Setup complete',
    'Setup complete',
    'Signed startup verification and your restart and sync confirmation are recorded. Keep your backup folder.',
  );
}
export function deviceCycle(kind, id, step) {
  const config = {
    folders: [
      'Restart your Kobo',
      [
        'Safely eject and disconnect USB.',
        'Fully restart the Kobo and wait for its home screen.',
        'Reconnect USB and tap Connect on the Kobo.',
      ],
      'I safely ejected, fully restarted the Kobo and reconnected USB.',
    ],
    collection: [
      'Collect system settings',
      [
        'Safely eject and disconnect USB.',
        'Let the Kobo apply the update and restart. Wait for its home screen.',
        'Reconnect USB and tap Connect on the Kobo.',
      ],
      'I let the Kobo finish its update and reconnected USB.',
    ],
    install: [
      'Apply the installation',
      [
        'Safely eject and disconnect USB.',
        'Let the Kobo apply the update and restart. Wait for its home screen.',
        'Reconnect USB and tap Connect on the Kobo.',
      ],
      'I let the Kobo finish its update and reconnected USB.',
    ],
    update: [
      'Apply the update',
      [
        'Safely eject and disconnect USB.',
        'Let the Kobo apply the update and restart. Wait for its home screen.',
        'Reconnect USB and tap Connect on the Kobo.',
      ],
      'I let the Kobo finish its update and reconnected USB.',
    ],
    status: [
      'Let the Kobo connect',
      [
        'Safely eject and disconnect USB.',
        'Let the Kobo return home and connect to Wi-Fi. A firmware update is not normally shown.',
        'Reconnect USB. The signed result will be checked next.',
      ],
      'I disconnected, let the Kobo connect to Wi-Fi and reconnected USB.',
    ],
    sync: [
      'Test syncing',
      [
        'Safely eject and disconnect USB.',
        'Try syncing on the Kobo and check that it succeeds.',
        'Reconnect USB and tap Connect on the Kobo.',
      ],
      'Sync succeeded on the Kobo and I reconnected USB.',
    ],
    final: [
      'Test startup and syncing',
      [
        'Safely eject and disconnect USB.',
        'Fully restart the Kobo. Connect it to a different internet connection and try syncing.',
        'Reconnect USB to record your result.',
      ],
      'I fully restarted the Kobo, sync succeeded on another connection and I reconnected USB.',
    ],
  };
  const [title, instructions, acknowledgement] = config[kind];
  return { kind, id, step, title, instructions, acknowledgement };
}

// Retained enrolment is a hint, not a reason to ignore a verified NeedsLogin.
export function nextConnectionJob({ existingEnrollment, status, signin, opened }) {
  if (existingEnrollment && !status && !signin) return 'status';
  return opened || (status && status.BackendState !== 'NeedsLogin')
    ? 'status'
    : 'enrol';
}
