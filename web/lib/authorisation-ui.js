// Presentation follows verified native reports; opening a sign-in page never
// counts as a healthy connection or unlocks endpoint/startup actions.
export function authorisationStep({
  active,
  systemBackup,
  configured,
  pending,
  returned,
  status,
  signin,
  opened,
  healthy,
  existingEnrollment = false,
}) {
  if (healthy)
    return {
      action: 'none',
      label: 'Kobo authorised',
      instruction: 'Connection verified. Continue to the sync address below.',
      disabled: true,
    };
  if (pending) {
    if (!['enrol', 'status'].includes(pending.action))
      return {
        action: 'none',
        label: 'Authorise Kobo',
        instruction: 'Finish the current Kobo step first.',
        disabled: true,
      };
    return {
      action: 'read',
      label: 'Read Kobo result',
      instruction: returned
        ? 'Read the result from your reconnected Kobo.'
        : 'Disconnect USB, let Wi-Fi connect, then reconnect and confirm the steps above.',
      disabled: !returned,
    };
  }
  if (!active || !systemBackup || !configured)
    return {
      action: 'none',
      label: 'Authorise Kobo',
      instruction: 'Complete connection support and its system backup first.',
      disabled: true,
    };
  if (existingEnrollment && !status && !signin)
    return {
      action: 'status',
      label: 'Check connection',
      instruction:
        'Check the existing Tailscale connection. Enrolment has been retained.',
      disabled: false,
    };
  if (signin && !opened)
    return {
      action: 'open',
      label: 'Authorise on Tailscale',
      instruction:
        'Open Tailscale and approve this Kobo. Then return here to check its connection.',
      disabled: false,
    };
  if (opened || (status && status.BackendState !== 'NeedsLogin'))
    return {
      action: 'status',
      label: 'Check connection',
      instruction: opened
        ? 'Finish authorising in Tailscale, then check the connection here.'
        : 'Check the connection again after resolving any reported problem.',
      disabled: false,
    };
  return {
    action: 'enrol',
    label: status ? 'Get sign-in link' : 'Prepare authorisation',
    instruction: status
      ? 'Prepare a new sign-in link for this Kobo.'
      : 'Prepare authorisation. The app will guide the disconnect and reconnect steps.',
    disabled: false,
  };
}
