import { getMetadata } from '../../scripts/ak.js';

const COUNTRIES = [['DE', 'Germany'], ['US', 'United States'], ['CR', 'Costa Rica']];

const MESSAGES = {
  401: 'Your session or code is no longer valid. Please try again.',
  409: 'We could not complete this request. If you have registered before, log in instead.',
  429: 'Too many attempts. Please wait a moment and try again.',
  fields: 'Please correct the highlighted fields.',
  registered: 'You are registered.',
  sent: 'We sent a code to your email.',
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

async function getSession() {
  try {
    const res = await fetch('/api/session', { mode: 'same-origin', cache: 'no-store' });
    if (!res.ok) { return null; }
    const session = await res.json();
    return typeof session?.csrfToken === 'string' ? session : null;
  } catch {
    return null;
  }
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

function field(prefix, name, label, attrs = {}, options = null) {
  const id = `${prefix}-${name}`;
  const control = options
    ? tag('select', attrs, ...[['', 'Select a country'], ...options].map(([value, text]) => tag('option', { value, text })))
    : tag('input', { type: 'text', ...attrs });
  Object.assign(control, { id, name, required: true });
  control.setAttribute('aria-describedby', `${id}-error`);
  return tag(
    'div',
    { class: 'register-field' },
    tag('label', { for: id, text: label }),
    control,
    tag('p', { id: `${id}-error`, class: 'register-field-error' }),
  );
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
    const control = el.elements[name];
    if (control) {
      control.setAttribute('aria-invalid', 'true');
      el.querySelector(`#${control.id}-error`).textContent = message;
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
  let session = null;

  const controls = tag('div', { class: 'register-controls' });
  const message = tag('p', { class: 'register-message', 'aria-live': 'polite' });
  const openButton = tag('button', { type: 'button', class: 'register-button', text: 'Register' });
  const logoutButton = tag('button', { type: 'button', class: 'register-button', text: 'Logout' });
  const user = tag('p', { class: 'register-user' });

  const reg = `${prefix}-register`;
  const login = `${prefix}-login`;
  const registerForm = form(
    'Register',
    field(reg, 'firstName', 'First name', { autocomplete: 'given-name' }),
    field(reg, 'lastName', 'Last name', { autocomplete: 'family-name' }),
    field(reg, 'email', 'Email', { type: 'email', autocomplete: 'email' }),
    field(reg, 'country', 'Country', { autocomplete: 'country' }, COUNTRIES),
  );
  const loginForm = form(
    'Login',
    field(login, 'email', 'Email', { type: 'email', autocomplete: 'email' }),
    field(login, 'code', 'Code', { inputmode: 'numeric', autocomplete: 'one-time-code' }),
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

  const panels = [['Register', tag('div', {}, registerForm)], ['Login', tag('div', {}, loginForm)]];
  const unavailable = tag('p', { class: 'register-unavailable', 'aria-live': 'polite' });
  const content = tag('div', { class: 'register-content' }, tabs(prefix, panels), ...panels.map(([, panel]) => panel));
  const close = tag('button', { type: 'button', class: 'register-close', 'aria-label': 'Close', text: '×' });
  const dialog = tag(
    'dialog',
    { class: 'register-dialog', 'aria-labelledby': `${prefix}-title` },
    tag('div', { class: 'register-header' }, tag('h2', { id: `${prefix}-title`, text: 'Register or log in' }), close),
    unavailable,
    content,
  );
  close.addEventListener('click', () => dialog.close());

  const render = () => {
    if (session?.authenticated) {
      user.textContent = ['Logged in', session.profile?.firstName].filter(Boolean).join(' as ');
      controls.replaceChildren(user, logoutButton);
    } else {
      controls.replaceChildren(openButton);
    }
  };

  const changed = () => {
    render();
    const authenticated = session?.authenticated ?? false;
    const firstName = session?.profile?.firstName;
    document.dispatchEvent(new CustomEvent('session:changed', { detail: { authenticated, firstName } }));
  };

  const showAvailability = () => {
    content.hidden = !session;
    unavailable.textContent = session ? '' : MESSAGES.unavailable;
  };

  const loggedIn = async (target) => {
    session = await getSession();
    if (session?.authenticated) {
      dialog.close();
      changed();
      logoutButton.focus();
      return;
    }
    if (!session) {
      showAvailability();
      return;
    }
    target.querySelector('.register-status').textContent = target === registerForm
      ? MESSAGES.registered : MESSAGES.error;
  };

  const submitting = async (target, request) => {
    clearErrors(target);
    const submit = target.querySelector('.register-submit');
    submit.disabled = true;
    const result = await request();
    submit.disabled = false;
    if (!result.ok) { showResult(target, result); }
    return result.ok;
  };

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(registerForm));
    const eventId = getMetadata('event-id');
    const ok = await submitting(registerForm, () => post('/api/register', session.csrfToken, { eventId, fields }));
    if (ok) { await loggedIn(registerForm); }
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = loginForm.elements.email.value;
    if (code.disabled) {
      const ok = await submitting(loginForm, () => post('/api/otp/request', session.csrfToken, { email }));
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
    const ok = await submitting(loginForm, () => post('/api/otp/verify', session.csrfToken, body));
    if (ok) {
      resetLogin();
      code.value = '';
      await loggedIn(loginForm);
    }
  });

  openButton.addEventListener('click', async () => {
    content.hidden = !session;
    dialog.showModal();
    session ??= await getSession();
    showAvailability();
  });

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
  getSession().then((restored) => {
    session = restored;
    render();
  });
}
