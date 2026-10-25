import { ipv4, ports, settings, parsePolicy } from './core.js';
const defaults = {
  ip: '100.101.102.103',
  ports: '8083',
  hostname: 'kobo-reader',
  tag: 'tag:kobo-sync',
  owner: 'autogroup:admin',
};
export const normaliseHostname = (value) =>
  String(value).trim().toLowerCase().replace(/\s+/g, '-');
export function fieldError(name, value, values = {}) {
  const text = String(value ?? '').trim();
  try {
    if (name === 'original-policy') {
      if (!text)
        return 'Paste your current policy. Enter {} only if it is intentionally empty.';
      parsePolicy(text);
      return '';
    }
    if (name === 'extra-deny') {
      for (const item of text
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)) {
        const match = item.match(/^([0-9.]+):(\d+)$/);
        if (!match)
          return 'Enter IPv4:port destinations separated by commas, for example 100.101.102.103:22.';
        const address = ipv4(match[1]),
          [port] = ports(match[2]);
        if (
          address === String(values.ip ?? '').trim() &&
          ports(values.ports ?? '8083').includes(port)
        )
          return 'A deny test cannot use the server address and a TCP port you are allowing.';
      }
      return '';
    }
    if (!text) return 'Enter a value for this field.';
    if (name === 'ip') ipv4(text, true);
    else if (name === 'ports') ports(text);
    else settings({ ...defaults, [name]: text });
    return '';
  } catch {
    return (
      {
        ip: 'Enter a Tailscale IPv4 address from 100.64.0.0 to 100.127.255.255. Use numbers and dots only.',
        ports: 'Enter 1–16 TCP ports from 1 to 65535, separated by commas.',
        hostname:
          'Use 1–63 letters, numbers or dashes. Start and end with a letter or number. Remove other symbols.',
        tag: 'Start with tag: and a lowercase letter, then use lowercase letters, numbers or dashes (up to 63 characters after tag:).',
        owner:
          'Enter autogroup:admin, a group such as group:family, or one account email without spaces.',
        'extra-deny': 'Enter valid IPv4:port destinations, with ports from 1 to 65535.',
        'original-policy':
          'Enter a complete JSON or HuJSON policy object. Check brackets, quotes and commas.',
      }[name] ?? 'Check this value.'
    );
  }
}
export function attachValidation(form) {
  const names = [
    'ip',
    'ports',
    'hostname',
    'tag',
    'owner',
    'extra-deny',
    'original-policy',
  ];
  const fields = names.map((id) => form.querySelector('#' + id)),
    touched = new Set();
  const values = () => Object.fromEntries(fields.map((f) => [f.id, f.value]));
  function check(field) {
    const error = fieldError(field.id, field.value, values());
    field.setCustomValidity(error);
    field.setAttribute('aria-invalid', String(!!error));
    const target = form.querySelector('#' + field.id + '-error');
    target.textContent = error;
    target.hidden = !error;
    return !error;
  }
  for (const field of fields) {
    const message = document.createElement('small');
    message.id = field.id + '-error';
    message.className = 'field-error';
    message.hidden = true;
    message.setAttribute('aria-live', 'polite');
    field.after(message);
    field.setAttribute(
      'aria-describedby',
      [field.getAttribute('aria-describedby') ?? '', message.id]
        .filter(Boolean)
        .join(' '),
    );
    field.addEventListener('blur', () => {
      touched.add(field.id);
      if (field.id === 'hostname') {
        const value = normaliseHostname(field.value);
        if (field.value !== value) {
          field.value = value;
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      check(field);
    });
    field.addEventListener('input', () => {
      if (touched.has(field.id)) check(field);
      for (const dependent of fields.filter(
        (f) => f.id === 'extra-deny' && touched.has(f.id),
      ))
        check(dependent);
    });
  }
  // Use inline, focused errors rather than the browser's transient bubble.
  form.noValidate = true;
  return (focus = true) => {
    const invalid = fields.filter((f) => {
      touched.add(f.id);
      if (f.id === 'hostname') f.value = normaliseHostname(f.value);
      return !check(f);
    });
    if (invalid.length) {
      if (focus) invalid[0].focus();
      return false;
    }
    return true;
  };
}
