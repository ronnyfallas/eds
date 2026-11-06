import { expect } from '@esm-bundle/chai';
import { sendKeys } from '@web/test-runner-commands';
import init from '../../blocks/register/register.js';

const realFetch = window.fetch;
const mounted = [];
let routes = {};
let calls = [];
let events = [];
let htmlWrites = 0;
let storageWrites = 0;

const ANON = { authenticated: false, csrfToken: 't1', mode: 'anonymous', profile: null, registeredEvents: [] };
const ANA = {
  authenticated: true,
  csrfToken: 't2',
  mode: 'member',
  profile: { firstName: 'Ana', lastName: 'Mora', email: 'ana@example.com', country: 'CR' },
  registeredEvents: ['houston-2026'],
};

const CONFIG = 'GET /api/event-config?eventId=houston-2026';
const ALL_MODES = { body: { modes: ['guest', 'otp', 'sso'], registrationMode: 'hybrid' } };

// Each route is a queue of responses; the last one repeats. Event config defaults to all modes.
function mockFetch(table) {
  routes = Object.fromEntries(Object.entries({ [CONFIG]: ALL_MODES, ...table })
    .map(([key, value]) => [key, [].concat(value)]));
}

window.fetch = async (url, opts = {}) => {
  const key = `${opts.method ?? 'GET'} ${url}`;
  calls.push({ key, opts, body: opts.body && JSON.parse(opts.body) });
  const queue = routes[key];
  const next = queue?.length > 1 ? queue.shift() : queue?.[0];
  if (!next || next === 'network') { throw new TypeError('Failed to fetch'); }
  const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
  return new Response(next.status === 204 ? null : body, { status: next.status ?? 200 });
};

const settle = () => new Promise((resolve) => { setTimeout(resolve, 20); });

async function mount({ eventId = 'houston-2026', registrationMode } = {}) {
  [['event-id', eventId], ['registration-mode', registrationMode]]
    .filter(([, content]) => content !== undefined)
    .forEach(([name, content]) => {
      const meta = document.createElement('meta');
      Object.assign(meta, { name, content });
      document.head.append(meta);
      mounted.push(meta);
    });
  const el = document.createElement('div');
  el.className = 'register';
  document.body.append(el);
  mounted.push(el);
  init(el);
  await settle();
  return el;
}

function fill(form, values) {
  for (const [name, value] of Object.entries(values)) { form.elements[name].value = value; }
}

async function submit(form, values) {
  fill(form, values);
  form.requestSubmit();
  await settle();
}

async function open(el) {
  el.querySelector('.register-button').click();
  await settle();
  return el.querySelector('dialog');
}

const REGISTRATION = { firstName: 'Ana', lastName: 'Mora', email: 'ana@example.com', country: 'CR' };
const onChange = (e) => events.push(e.detail);

before(() => {
  ['innerHTML', 'outerHTML'].forEach((prop) => {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    Object.defineProperty(Element.prototype, prop, {
      ...desc,
      set(value) { htmlWrites += 1; desc.set.call(this, value); },
    });
  });
  const { insertAdjacentHTML } = Element.prototype;
  Element.prototype.insertAdjacentHTML = function spy(...args) {
    htmlWrites += 1;
    return insertAdjacentHTML.apply(this, args);
  };
  const { setItem } = Storage.prototype;
  Storage.prototype.setItem = function spy(...args) {
    storageWrites += 1;
    return setItem.apply(this, args);
  };
});

after(() => { window.fetch = realFetch; });

beforeEach(() => {
  calls = [];
  events = [];
  document.addEventListener('session:changed', onChange);
});

afterEach(() => {
  document.removeEventListener('session:changed', onChange);
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  mounted.splice(0).forEach((node) => node.remove());
  expect(htmlWrites, 'no HTML string sinks').to.equal(0);
  expect(storageWrites, 'no web storage writes').to.equal(0);
});

describe('register: session restore', () => {
  it('fetches the session same-origin on load and shows Register', async () => {
    mockFetch({ 'GET /api/session': { body: ANON } });
    const el = await mount();
    expect(calls[0].key).to.equal('GET /api/session');
    expect(calls[0].opts.mode).to.equal('same-origin');
    expect(el.querySelector('.register-button').textContent).to.equal('Register');
  });

  it('shows the user and a Logout button when authenticated', async () => {
    mockFetch({ 'GET /api/session': { body: ANA } });
    const el = await mount();
    expect(el.querySelector('.register-user').textContent).to.equal('Logged in as Ana');
    const buttons = [...el.querySelectorAll('.register-controls button')].map((b) => b.textContent);
    expect(buttons).to.deep.equal(['Logout']);
  });

  [
    ['404', { status: 404, body: 'Not found' }],
    ['a network error', 'network'],
    ['non-JSON', { body: '<html>oops</html>' }],
  ].forEach(([label, response]) => {
    it(`degrades to an unavailable message on ${label}`, async () => {
      const logged = [];
      const { error, warn, log } = console;
      console.error = (...a) => logged.push(a);
      console.warn = console.error;
      console.log = console.error;
      try {
        mockFetch({ 'GET /api/session': response });
        const el = await mount();
        expect(el.querySelector('.register-button').textContent).to.equal('Register');
        const dialog = await open(el);
        expect(dialog.open).to.be.true;
        expect(dialog.querySelector('.register-unavailable').textContent)
          .to.equal('Registration is unavailable right now.');
        expect(dialog.querySelector('.register-content').hidden).to.be.true;
        expect(calls.map((c) => c.key)).to.deep.equal(['GET /api/session', 'GET /api/session', CONFIG]);
      } finally {
        Object.assign(console, { error, warn, log });
      }
      expect(logged).to.deep.equal([]);
    });
  });
});

describe('register: dialog', () => {
  beforeEach(() => mockFetch({ 'GET /api/session': { body: ANON } }));

  it('opens a labelled modal with labelled fields', async () => {
    const el = await mount();
    const dialog = await open(el);
    expect(dialog.matches(':modal')).to.be.true;
    const title = document.getElementById(dialog.getAttribute('aria-labelledby'));
    expect(title.textContent).to.equal('Register or log in');
    for (const control of dialog.querySelectorAll('input, select')) {
      expect(control.labels.length, control.name).to.equal(1);
      expect(document.getElementById(control.getAttribute('aria-describedby')), control.name).to.exist;
    }
    expect([...dialog.querySelector('select').options].map((o) => o.value)).to.deep.equal(['', 'DE', 'US', 'CR']);
  });

  it('switches tabs with the arrow keys', async () => {
    const el = await mount();
    const dialog = await open(el);
    const [registerTab, loginTab] = dialog.querySelectorAll('[role="tab"]');
    expect(registerTab.getAttribute('aria-selected')).to.equal('true');
    registerTab.focus();
    await sendKeys({ press: 'ArrowRight' });
    expect(document.activeElement).to.equal(loginTab);
    expect(loginTab.getAttribute('aria-selected')).to.equal('true');
    expect(registerTab.tabIndex).to.equal(-1);
    expect(document.getElementById(loginTab.getAttribute('aria-controls')).hidden).to.be.false;
    expect(document.getElementById(registerTab.getAttribute('aria-controls')).hidden).to.be.true;
  });

  it('keeps focus inside the dialog', async () => {
    const el = await mount();
    const dialog = await open(el);
    for (let i = 0; i < 15; i += 1) {
      await sendKeys({ press: 'Tab' });
      const active = document.activeElement;
      expect(active === document.body || dialog.contains(active), active.outerHTML).to.be.true;
    }
  });

  it('closes on Escape', async () => {
    const el = await mount();
    const dialog = await open(el);
    await sendKeys({ press: 'Escape' });
    expect(dialog.open).to.be.false;
  });
});

describe('register: register tab', () => {
  it('posts eventId and fields with the CSRF token, then refreshes the session', async () => {
    mockFetch({ 'GET /api/session': [{ body: ANON }, { body: ANA }], 'POST /api/register': { status: 201 } });
    const el = await mount();
    const dialog = await open(el);
    await submit(dialog.querySelector('form'), REGISTRATION);

    const post = calls.find((c) => c.key === 'POST /api/register');
    expect(post.opts.mode).to.equal('same-origin');
    expect(post.opts.headers['x-csrf-token']).to.equal('t1');
    expect(post.body).to.deep.equal({ eventId: 'houston-2026', fields: REGISTRATION });
    expect(calls.at(-1).key).to.equal('GET /api/session');
    expect(dialog.open).to.be.false;
    expect(el.querySelector('.register-user').textContent).to.equal('Logged in as Ana');
    expect(events).to.deep.equal([{ authenticated: true, firstName: 'Ana' }]);
  });

  it('shows 422 errors next to each field', async () => {
    mockFetch({
      'GET /api/session': { body: ANON },
      'POST /api/register': { status: 422, body: { errors: { email: 'Email is invalid', country: 'Pick a country' } } },
    });
    const el = await mount();
    const dialog = await open(el);
    const form = dialog.querySelector('form');
    await submit(form, REGISTRATION);

    for (const [name, text] of [['email', 'Email is invalid'], ['country', 'Pick a country']]) {
      const control = form.elements[name];
      expect(control.getAttribute('aria-invalid')).to.equal('true');
      expect(document.getElementById(control.getAttribute('aria-describedby')).textContent).to.equal(text);
    }
    expect(form.elements.firstName.hasAttribute('aria-invalid')).to.be.false;
    expect(document.activeElement).to.equal(form.elements.email);
    const status = form.querySelector('.register-status');
    expect(status.getAttribute('aria-live')).to.equal('polite');
    expect(status.textContent).to.equal('Please correct the highlighted fields.');
    expect(dialog.open).to.be.true;
  });

  [
    [409, 'We could not complete this request. If you have registered before, log in instead.'],
    [401, 'Your session or code is no longer valid. Please try again.'],
    [429, 'Too many attempts. Please wait a moment and try again.'],
    [500, 'Something went wrong. Please try again.'],
  ].forEach(([status, text]) => {
    it(`shows a generic message for ${status}`, async () => {
      mockFetch({ 'GET /api/session': { body: ANON }, 'POST /api/register': { status } });
      const el = await mount();
      const dialog = await open(el);
      const form = dialog.querySelector('form');
      await submit(form, REGISTRATION);
      expect(form.querySelector('.register-status').textContent).to.equal(text);
      expect(form.querySelector('[aria-invalid]')).to.be.null;
      expect(calls.filter((c) => c.key === 'GET /api/session')).to.have.length(1);
      expect(events).to.deep.equal([]);
    });
  });
});

describe('register: login tab', () => {
  it('requests then verifies a code, then refreshes the session', async () => {
    mockFetch({
      'GET /api/session': [{ body: ANON }, { body: ANA }],
      'POST /api/otp/request': { status: 204 },
      'POST /api/otp/verify': { status: 200 },
    });
    const el = await mount();
    const dialog = await open(el);
    dialog.querySelectorAll('[role="tab"]')[1].click();
    const form = dialog.querySelector('.register-form-login');
    const button = form.querySelector('.register-submit');
    expect(form.elements.code.parentElement.hidden).to.be.true;
    expect(button.textContent).to.equal('Send code');

    await submit(form, { email: 'ana@example.com' });
    const request = calls.find((c) => c.key === 'POST /api/otp/request');
    expect(request.body).to.deep.equal({ email: 'ana@example.com' });
    expect(request.opts.headers['x-csrf-token']).to.equal('t1');
    expect(form.elements.code.parentElement.hidden).to.be.false;
    expect(document.activeElement).to.equal(form.elements.code);
    expect(button.textContent).to.equal('Verify');

    await submit(form, { code: '123456' });
    const verify = calls.find((c) => c.key === 'POST /api/otp/verify');
    expect(verify.body).to.deep.equal({ email: 'ana@example.com', code: '123456' });
    expect(verify.opts.headers['x-csrf-token']).to.equal('t1');
    expect(calls.at(-1).key).to.equal('GET /api/session');
    expect(dialog.open).to.be.false;
    expect(el.querySelector('.register-user').textContent).to.equal('Logged in as Ana');
    expect(events).to.deep.equal([{ authenticated: true, firstName: 'Ana' }]);
  });

  it('shows a 422 error next to the code', async () => {
    mockFetch({
      'GET /api/session': { body: ANON },
      'POST /api/otp/request': { status: 204 },
      'POST /api/otp/verify': { status: 422, body: { errors: { code: 'Code is wrong' } } },
    });
    const el = await mount();
    const dialog = await open(el);
    const form = dialog.querySelector('.register-form-login');
    await submit(form, { email: 'ana@example.com' });
    await submit(form, { code: '000000' });
    expect(form.elements.code.getAttribute('aria-invalid')).to.equal('true');
    expect(document.getElementById(form.elements.code.getAttribute('aria-describedby')).textContent)
      .to.equal('Code is wrong');
  });

  it('shows a generic message when code requests are rate limited', async () => {
    mockFetch({ 'GET /api/session': { body: ANON }, 'POST /api/otp/request': { status: 429 } });
    const el = await mount();
    const dialog = await open(el);
    const form = dialog.querySelector('.register-form-login');
    await submit(form, { email: 'ana@example.com' });
    expect(form.querySelector('.register-status').textContent)
      .to.equal('Too many attempts. Please wait a moment and try again.');
    expect(form.elements.code.parentElement.hidden).to.be.true;
  });
});

describe('register: logout', () => {
  it('posts with the current token, refreshes the session and uses the new token', async () => {
    mockFetch({
      'GET /api/session': [{ body: ANA }, { body: { ...ANON, csrfToken: 't3' } }],
      'POST /api/logout': { status: 204 },
      'POST /api/register': { status: 409 },
    });
    const el = await mount();
    el.querySelector('.register-controls button').click();
    await settle();

    const logout = calls.find((c) => c.key === 'POST /api/logout');
    expect(logout.opts.headers['x-csrf-token']).to.equal('t2');
    expect(calls.at(-1).key).to.equal('GET /api/session');
    expect(el.querySelector('.register-button').textContent).to.equal('Register');
    expect(events).to.deep.equal([{ authenticated: false, firstName: undefined }]);

    const dialog = await open(el);
    await submit(dialog.querySelector('form'), REGISTRATION);
    expect(calls.at(-1).opts.headers['x-csrf-token']).to.equal('t3');
  });

  it('keeps the logged-in state and shows a message when logout fails', async () => {
    mockFetch({ 'GET /api/session': { body: ANA }, 'POST /api/logout': { status: 401 } });
    const el = await mount();
    el.querySelector('.register-controls button').click();
    await settle();
    expect(el.querySelector('.register-user').textContent).to.equal('Logged in as Ana');
    expect(el.querySelector('.register-message').textContent)
      .to.equal('Your session or code is no longer valid. Please try again.');
    expect(events).to.deep.equal([]);
  });
});

describe('register: event config', () => {
  const view = (dialog) => ({
    tabs: [...dialog.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
    forms: [...dialog.querySelectorAll('form')].map((form) => form.className),
    sso: dialog.querySelector('.register-sso')?.getAttribute('href') ?? null,
    unavailable: dialog.querySelector('.register-unavailable').textContent,
  });
  const ssoHref = () => `/api/login/sso?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  const REG = 'register-form-register';
  const LOGIN = 'register-form-login';

  it('requests the config same-origin with the encoded event id before showing forms', async () => {
    const eventId = 'hou ston/26&x=1';
    const key = `GET /api/event-config?eventId=${encodeURIComponent(eventId)}`;
    mockFetch({ 'GET /api/session': { body: ANON }, [key]: ALL_MODES });
    const el = await mount({ eventId });
    expect(el.querySelector('form'), 'no form before the config arrives').to.be.null;
    expect(calls.map((c) => c.key)).to.deep.equal(['GET /api/session']);
    await open(el);
    const call = calls.find((c) => c.key === key);
    expect(call.opts.mode).to.equal('same-origin');
    expect(el.querySelectorAll('form')).to.have.length(2);
  });

  [undefined, 'hybrid', 'banana'].forEach((registrationMode) => {
    it(`shows every mode in modes when registration-mode is ${registrationMode ?? 'missing'}`, async () => {
      mockFetch({ 'GET /api/session': { body: ANON } });
      const dialog = await open(await mount({ registrationMode }));
      expect(view(dialog)).to.deep.equal({ tabs: ['Register', 'Login'], forms: [REG, LOGIN], sso: ssoHref(), unavailable: '' });
    });
  });

  [
    ['guest', { tabs: [], forms: [REG], sso: null, unavailable: '' }],
    ['otp', { tabs: [], forms: [LOGIN], sso: null, unavailable: '' }],
    ['sso', { tabs: [], forms: [], sso: ssoHref(), unavailable: '' }],
    [' OTP ', { tabs: [], forms: [LOGIN], sso: null, unavailable: '' }],
  ].forEach(([registrationMode, expected]) => {
    it(`shows only ${registrationMode.trim()} without tabs when registration-mode is "${registrationMode}"`, async () => {
      mockFetch({ 'GET /api/session': { body: ANON } });
      const dialog = await open(await mount({ registrationMode }));
      expect(view(dialog)).to.deep.equal(expected);
      expect(dialog.querySelector('[role="tablist"], [role="tabpanel"]')).to.be.null;
    });
  });

  it('shows unavailable when the requested mode is not in modes', async () => {
    mockFetch({ 'GET /api/session': { body: ANON }, [CONFIG]: { body: { modes: ['guest', 'otp'] } } });
    const dialog = await open(await mount({ registrationMode: 'sso' }));
    expect(view(dialog)).to.deep.equal({ tabs: [], forms: [], sso: null, unavailable: 'Registration is unavailable right now.' });
    expect(dialog.querySelector('.register-content').hidden).to.be.true;
  });

  [
    [['guest', 'sso'], { tabs: [], forms: [REG], sso: ssoHref(), unavailable: '' }],
    [['otp'], { tabs: [], forms: [LOGIN], sso: null, unavailable: '' }],
    [['sso', 'otp', 'magic'], { tabs: [], forms: [LOGIN], sso: ssoHref(), unavailable: '' }],
  ].forEach(([modes, expected]) => {
    it(`limits hybrid to modes ${modes.join(', ')}`, async () => {
      mockFetch({ 'GET /api/session': { body: ANON }, [CONFIG]: { body: { modes } } });
      const dialog = await open(await mount({ registrationMode: 'hybrid' }));
      expect(view(dialog)).to.deep.equal(expected);
    });
  });

  it('makes SSO a plain top-level link, not a fetch', async () => {
    mockFetch({ 'GET /api/session': { body: ANON } });
    const dialog = await open(await mount({ registrationMode: 'sso' }));
    const link = dialog.querySelector('.register-sso');
    expect(link.tagName).to.equal('A');
    expect(link.textContent).to.equal('Continue with corporate login');
    expect(link.target).to.equal('');
    expect(calls.some((c) => c.key.includes('/api/login/sso'))).to.be.false;
  });

  [
    ['404', { status: 404, body: 'Not found' }],
    ['a network error', 'network'],
    ['non-JSON', { body: '<html>oops</html>' }],
    ['a response without modes', { body: { registrationMode: 'hybrid' } }],
  ].forEach(([label, response]) => {
    it(`shows unavailable and no forms when event config fails with ${label}`, async () => {
      const logged = [];
      const { error, warn, log } = console;
      console.error = (...a) => logged.push(a);
      console.warn = console.error;
      console.log = console.error;
      try {
        mockFetch({ 'GET /api/session': { body: ANON }, [CONFIG]: [response, ALL_MODES] });
        const el = await mount();
        const dialog = await open(el);
        expect(view(dialog)).to.deep.equal({ tabs: [], forms: [], sso: null, unavailable: 'Registration is unavailable right now.' });
        expect(el.querySelector('.register-button').textContent).to.equal('Register');

        dialog.close();
        await open(el);
        expect(view(dialog).forms, 'retries on the next open').to.deep.equal([REG, LOGIN]);
      } finally {
        Object.assign(console, { error, warn, log });
      }
      expect(logged).to.deep.equal([]);
    });
  });

  it('fetches the config once and reuses it', async () => {
    mockFetch({ 'GET /api/session': { body: ANON } });
    const el = await mount();
    const dialog = await open(el);
    dialog.close();
    await open(el);
    expect(calls.filter((c) => c.key === CONFIG)).to.have.length(1);
  });
});
