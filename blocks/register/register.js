import { getMetadata } from '../../scripts/ak.js';

const MODES = ['guest', 'otp', 'sso'];
const INPUT_TYPES = ['text', 'email', 'tel', 'checkbox'];
const AUTOCOMPLETE = {
  firstName: 'given-name',
  lastName: 'family-name',
  email: 'email',
  company: 'organization',
  country: 'country',
  phone: 'tel',
};

const MESSAGES = {
  401: 'Your session or code is no longer valid. Please try again.',
  409: 'We could not complete this request. If you have registered before, log in instead.',
  429: 'Too many attempts. Please wait a moment and try again.',
  fields: 'Please correct the highlighted fields.',
  thanks: 'Thank you, you are registered',
  sent: 'We sent a code to your email.',
  consentPending: 'Please wait for the consent terms to load, then try again.',
  consentError: 'Consent terms are unavailable right now. Please try again.',
  unavailable: 'Registration is unavailable right now.',
  error: 'Something went wrong. Please try again.',
};

let count = 0;

function tag(name, attrs = {}, ...children) {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') {
      node.textContent = value;
    } else {
      node.setAttribute(key, value);
    }
  }
  node.append(...children);
  return node;
}

async function getJson(path, valid, opts = {}) {
  try {
    const res = await fetch(path, { mode: 'same-origin', ...opts });
    if (!res.ok) { return null; }
    const data = await res.json();
    return valid(data) ? data : null;
  } catch {
    return null;
  }
}

const getSession = () => getJson('/api/session', (s) => typeof s?.csrfToken === 'string', { cache: 'no-store' });

const getEventConfig = () => getJson(
  `/api/event-config?eventId=${encodeURIComponent(getMetadata('event-id') ?? '')}`,
  (config) => Array.isArray(config?.modes),
);

const getFields = (fieldSet) => getJson(
  `/api/fields?fieldSet=${encodeURIComponent(fieldSet ?? '')}`,
  (data) => Array.isArray(data?.fields) && data.fields.every((f) => typeof f?.name === 'string'),
);

const getConsent = (country) => getJson(
  `/api/consent?country=${encodeURIComponent(country)}`,
  (data) => typeof data?.version === 'string' && Array.isArray(data.checkboxes),
);

function allowedModes({ modes }) {
  const mode = getMetadata('registration-mode')?.trim().toLowerCase();
  if (MODES.includes(mode)) { return modes.includes(mode) ? [mode] : []; }
  return MODES.filter((m) => modes.includes(m));
}

async function post(path, token, body) {
  const headers = { 'x-csrf-token': token };
  if (body) { headers['content-type'] = 'application/json'; }
  try {
    const res = await fetch(path, {
      method: 'POST',
      mode: 'same-origin',
      headers,
      body: body && JSON.stringify(body),
    });
    const data = res.status === 422 ? await res.json().catch(() => ({})) : {};
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

function field(id, { name, type, label, required, options }, attrs = {}) {
  const control = type === 'select'
    ? tag('select', attrs, tag('option', { value: '', text: 'Select an option' }), ...(options ?? [])
      .map((option) => tag('option', { value: option.value, text: option.label })))
    : tag('input', { type: INPUT_TYPES.includes(type) ? type : 'text', ...attrs });
  Object.assign(control, { id, name, required: Boolean(required) });
  control.setAttribute('aria-describedby', `${id}-error`);
  const labelEl = tag('label', { for: id, text: label });
  const error = tag('p', { id: `${id}-error`, class: 'register-field-error' });
  return type === 'checkbox'
    ? tag('div', { class: 'register-field register-checkbox' }, control, labelEl, error)
    : tag('div', { class: 'register-field' }, labelEl, control, error);
}

function form(name, ...children) {
  const status = tag('p', { class: 'register-status', 'aria-live': 'polite' });
  const submit = tag('button', { type: 'submit', class: 'register-submit', text: name });
  return tag('form', { class: `register-form-${name.toLowerCase()}` }, ...children, status, submit);
}

function clearErrors(el) {
  el.querySelectorAll('[aria-invalid]').forEach((control) => control.removeAttribute('aria-invalid'));
  el.querySelectorAll('.register-field-error, .register-status').forEach((msg) => { msg.textContent = ''; });
}

function showResult(el, { status, data }) {
  const statusEl = el.querySelector('.register-status');
  if (status !== 422) {
    statusEl.textContent = MESSAGES[status] ?? MESSAGES.error;
    return;
  }
  const unmatched = [];
  let first;
  for (const [name, message] of Object.entries(data.errors ?? {})) {
    const control = el.elements.namedItem(name);
    if (control?.id) {
      control.setAttribute('aria-invalid', 'true');
      document.getElementById(control.getAttribute('aria-describedby')).textContent = message;
      first ??= control;
    } else {
      unmatched.push(message);
    }
  }
  statusEl.textContent = unmatched.join(' ') || MESSAGES.fields;
  first?.focus();
}

function tabs(prefix, panels) {
  const list = tag('div', { role: 'tablist', 'aria-labelledby': `${prefix}-title` });
  const buttons = panels.map(([label, panel]) => {
    const id = `${prefix}-tab-${label.toLowerCase()}`;
    panel.id = `${id}-panel`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', id);
    return tag('button', { type: 'button', role: 'tab', id, 'aria-controls': panel.id, text: label });
  });
  const select = (idx, focus) => {
    buttons.forEach((button, i) => {
      button.setAttribute('aria-selected', i === idx);
      button.tabIndex = i === idx ? 0 : -1;
      panels[i][1].hidden = i !== idx;
    });
    if (focus) { buttons[idx].focus(); }
  };
  buttons.forEach((button, i) => button.addEventListener('click', () => select(i)));
  list.addEventListener('keydown', (e) => {
    const idx = buttons.indexOf(document.activeElement);
    const last = buttons.length - 1;
    const next = {
      ArrowRight: idx === last ? 0 : idx + 1,
      ArrowLeft: idx === 0 ? last : idx - 1,
      Home: 0,
      End: last,
    }[e.key];
    if (idx < 0 || next === undefined) { return; }
    e.preventDefault();
    select(next, true);
  });
  list.append(...buttons);
  select(0);
  return list;
}

export default function init(el) {
  const prefix = `register-${count += 1}`;
  const eventId = getMetadata('event-id');
  let session = null;
  let config = null;
  let defs = null;
  let consent = null;
  let consentSeq = 0;
  let prefilledFor;
  let done = false;

  const controls = tag('div', { class: 'register-controls' });
  const message = tag('p', { class: 'register-message', 'aria-live': 'polite' });
  const openButton = tag('button', { type: 'button', class: 'register-button', text: 'Register' });
  const completeButton = tag('button', { type: 'button', class: 'register-button', text: 'Complete registration' });
  const logoutButton = tag('button', { type: 'button', class: 'register-button', text: 'Logout' });
  const user = tag('p', { class: 'register-user' });

  const fieldsBox = tag('div', { class: 'register-fields' });
  const consentBox = tag('fieldset', { class: 'register-consent', hidden: '' });
  const registerForm = form('Register', fieldsBox, consentBox);
  const registerStatus = registerForm.querySelector('.register-status');

  const login = `${prefix}-login`;
  const loginForm = form(
    'Login',
    field(`${login}-email`, { name: 'email', type: 'email', label: 'Email', required: true }, { autocomplete: 'email' }),
    field(`${login}-code`, { name: 'code', type: 'text', label: 'Code', required: true }, {
      inputmode: 'numeric', autocomplete: 'one-time-code',
    }),
  );
  const { code } = loginForm.elements;
  const codeField = code.parentElement;
  const loginSubmit = loginForm.querySelector('.register-submit');

  const resetLogin = () => {
    loginForm.elements.email.readOnly = false;
    code.disabled = true;
    codeField.hidden = true;
    loginSubmit.textContent = 'Send code';
  };
  resetLogin();

  const isReadOnly = (name) => Boolean(session?.readOnly?.includes(name));
  const registered = () => Boolean(session?.registeredEvents?.includes(eventId));

  const applyRequired = (names) => {
    for (const def of defs ?? []) {
      const control = registerForm.elements.namedItem(def.name);
      control.required = Boolean(def.required) || names.includes(def.name);
    }
  };

  const loadConsent = async () => {
    consentSeq += 1;
    const seq = consentSeq;
    const country = registerForm.elements.namedItem('country')?.value ?? '';
    consent = null;
    consentBox.replaceChildren();
    consentBox.hidden = true;
    applyRequired([]);
    if (!country) { return; }
    const data = await getConsent(country);
    if (seq !== consentSeq) { return; }
    if (!data) {
      registerStatus.textContent = MESSAGES.consentError;
      return;
    }
    consent = { ...data, country };
    const boxes = data.checkboxes.map((box, i) => field(
      `${prefix}-consent-${i}`,
      { name: box.id, type: 'checkbox', label: box.label, required: box.required },
    ));
    consentBox.replaceChildren(tag('legend', { text: 'Consent' }), tag('p', { text: data.text ?? '' }), ...boxes);
    consentBox.hidden = false;
    applyRequired(Array.isArray(data.requiredFields) ? data.requiredFields : []);
  };

  const buildFields = () => {
    fieldsBox.replaceChildren(...defs.map((def, i) => field(
      `${prefix}-register-${i}`,
      def,
      AUTOCOMPLETE[def.name] ? { autocomplete: AUTOCOMPLETE[def.name] } : {},
    )));
    registerForm.elements.namedItem('country')?.addEventListener('change', loadConsent);
  };

  const prefill = () => {
    prefilledFor = session;
    registerForm.reset();
    clearErrors(registerForm);
    const profile = session?.profile ?? {};
    for (const def of defs) {
      const control = registerForm.elements.namedItem(def.name);
      const readOnly = isReadOnly(def.name);
      const value = profile[readOnly ? def.name : def.prefill];
      if ((readOnly || def.prefill) && value != null) { control.value = value; }
      if (control.tagName === 'SELECT') {
        control.disabled = readOnly;
      } else {
        control.readOnly = readOnly;
      }
    }
    loadConsent();
  };

  const forms = { guest: ['Register', registerForm], otp: ['Login', loginForm] };
  const sso = tag('a', { class: 'register-sso', text: 'Continue with corporate login' });
  const unavailable = tag('p', { class: 'register-unavailable', 'aria-live': 'polite' });
  const content = tag('div', { class: 'register-content' });
  const title = tag('h2', { id: `${prefix}-title` });
  const close = tag('button', { type: 'button', class: 'register-close', 'aria-label': 'Close', text: '×' });
  const dialog = tag(
    'dialog',
    { class: 'register-dialog', 'aria-labelledby': `${prefix}-title` },
    tag('div', { class: 'register-header' }, title, close),
    unavailable,
    content,
  );
  // If focus was lost (its opener was swapped while the dialog was open), move it to the controls.
  const closed = () => {
    if (done) {
      done = false;
      prefilledFor = undefined;
    }
    const active = document.activeElement;
    if (active === document.body || dialog.contains(active)) { controls.querySelector('button')?.focus(); }
  };
  const closeDialog = () => {
    dialog.close();
    closed();
  };
  close.addEventListener('click', closeDialog);
  dialog.addEventListener('close', closed);

  const compose = (modes) => {
    const panels = modes.filter((mode) => forms[mode])
      .map((mode) => [forms[mode][0], tag('div', {}, forms[mode][1])]);
    const parts = panels.map(([, panel]) => panel);
    if (panels.length > 1) { parts.unshift(tabs(prefix, panels)); }
    if (modes.includes('sso')) {
      const { pathname, search } = window.location;
      sso.setAttribute('href', `/api/login/sso?returnTo=${encodeURIComponent(pathname + search)}`);
      parts.push(sso);
    }
    content.replaceChildren(...parts);
    content.hidden = !session || !modes.length;
    unavailable.textContent = content.hidden ? MESSAGES.unavailable : '';
  };

  const render = () => {
    if (!session?.authenticated) {
      controls.replaceChildren(openButton);
      return;
    }
    user.textContent = ['Logged in', session.profile?.firstName].filter(Boolean).join(' as ');
    controls.replaceChildren(user, ...(registered() ? [] : [completeButton]), logoutButton);
  };

  const changed = () => {
    render();
    const authenticated = session?.authenticated ?? false;
    const firstName = session?.profile?.firstName;
    document.dispatchEvent(new CustomEvent('session:changed', { detail: { authenticated, firstName } }));
  };

  const openDialog = async (complete) => {
    title.textContent = complete ? 'Complete registration' : 'Register or log in';
    content.replaceChildren();
    content.hidden = true;
    unavailable.textContent = '';
    dialog.showModal();
    const [restored, loaded] = await Promise.all([
      session ?? getSession(),
      config ?? getEventConfig(),
    ]);
    session = restored;
    config = loaded;
    const modes = complete ? ['guest'] : config && allowedModes(config);
    if (config && modes.includes('guest') && !defs) {
      defs = (await getFields(config.fieldSet))?.fields ?? null;
      if (defs) { buildFields(); }
    }
    if (defs && session !== prefilledFor) { prefill(); }
    compose((modes ?? []).filter((mode) => mode !== 'guest' || defs));
  };

  const thanks = () => {
    done = true;
    const text = tag('p', { class: 'register-thanks', tabindex: '-1', text: MESSAGES.thanks });
    const button = tag('button', { type: 'button', class: 'register-submit', text: 'Close' });
    button.addEventListener('click', closeDialog);
    content.replaceChildren(text, button);
    content.hidden = false;
    unavailable.textContent = '';
    text.focus();
  };

  const submitting = async (target, request) => {
    clearErrors(target);
    const submit = target.querySelector('.register-submit');
    submit.disabled = true;
    const result = await request();
    submit.disabled = false;
    if (!result.ok) { showResult(target, result); }
    return result;
  };

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const country = registerForm.elements.namedItem('country')?.value;
    if (country && consent?.country !== country) {
      registerStatus.textContent = MESSAGES.consentPending;
      loadConsent();
      return;
    }
    const fields = Object.fromEntries(defs.filter((def) => !isReadOnly(def.name))
      .map((def) => [def.name, registerForm.elements.namedItem(def.name).value]));
    const body = { eventId, fields };
    if (consent) {
      const accepted = consent.checkboxes
        .filter((box) => registerForm.elements.namedItem(box.id)?.checked)
        .map((box) => box.id);
      body.consent = { version: consent.version, country, accepted };
    }
    const result = await submitting(registerForm, () => post('/api/register', session.csrfToken, body));
    if (!result.ok) {
      if (result.data.errors?.consent) { loadConsent(); }
      return;
    }
    session = await getSession();
    if (session?.authenticated) {
      changed();
    } else {
      render();
    }
    thanks();
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = loginForm.elements.email.value;
    if (code.disabled) {
      const { ok } = await submitting(loginForm, () => post('/api/otp/request', session.csrfToken, { email }));
      if (!ok) { return; }
      loginForm.elements.email.readOnly = true;
      code.disabled = false;
      codeField.hidden = false;
      loginSubmit.textContent = 'Verify';
      loginForm.querySelector('.register-status').textContent = MESSAGES.sent;
      code.focus();
      return;
    }
    const body = { email, code: code.value };
    const { ok } = await submitting(loginForm, () => post('/api/otp/verify', session.csrfToken, body));
    if (!ok) { return; }
    resetLogin();
    code.value = '';
    session = await getSession();
    if (session?.authenticated) {
      dialog.close();
      changed();
      controls.querySelector('button').focus();
    } else if (!session) {
      compose([]);
    } else {
      loginForm.querySelector('.register-status').textContent = MESSAGES.error;
    }
  });

  openButton.addEventListener('click', () => openDialog(false));
  completeButton.addEventListener('click', () => openDialog(true));

  logoutButton.addEventListener('click', async () => {
    message.textContent = '';
    const result = await post('/api/logout', session.csrfToken);
    if (!result.ok) {
      message.textContent = MESSAGES[result.status] ?? MESSAGES.error;
      return;
    }
    session = await getSession();
    changed();
    openButton.focus();
  });

  render();
  el.replaceChildren(controls, message, dialog);
  const restoring = getSession().then((restored) => {
    session = restored;
    render();
  });

  document.addEventListener('login:required', async () => {
    await restoring;
    if (!el.isConnected || document.querySelector('dialog.register-dialog[open]')) { return; }
    if (!session?.authenticated) {
      openDialog(false);
    } else if (!registered()) {
      openDialog(true);
    }
  });
}
