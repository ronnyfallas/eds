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

const PROFILE = { firstName: 'Ana', lastName: 'Mora', email: 'ana@example.com', company: 'Acme', country: 'CR' };
const ANON = { authenticated: false, csrfToken: 't1', mode: 'anonymous', profile: null, registeredEvents: [] };
const ANA = {
  authenticated: true,
  csrfToken: 't2',
  mode: 'otp',
  profile: PROFILE,
  registeredEvents: ['houston-2026'],
};
// Logged in through SSO, not yet registered for this event.
const SSO_NEW = {
  authenticated: true,
  csrfToken: 't4',
  mode: 'sso',
  profile: PROFILE,
  readOnly: ['email', 'country'],
  registeredEvents: ['other-2026'],
};

const FIELD_DEFS = [
  { name: 'firstName', type: 'text', label: 'First name', required: true, prefill: 'firstName' },
  { name: 'lastName', type: 'text', label: 'Last name', required: true },
  { name: 'email', type: 'email', label: 'Email', required: true },
  { name: 'company', type: 'text', label: 'Company', required: false },
  { name: 'phone', type: 'tel', label: 'Phone', required: false },
  {
    name: 'country',
    type: 'select',
    label: 'Country',
    required: true,
    options: [{ value: 'DE', label: 'Germany' }, { value: 'US', label: 'United States' }, { value: 'CR', label: 'Costa Rica' }],
  },
];
const consentFor = (country, extra = {}) => ({
  body: {
    country,
    version: `${country}-v1`,
    text: `Terms for ${country}.`,
    checkboxes: [
      { id: 'terms', label: 'I accept the terms', required: true },
      { id: 'news', label: 'Send me news', required: false },
    ],
    requiredFields: country === 'CR' ? ['company'] : [],
    ...extra,
  },
});

const CONFIG = 'GET /api/event-config?eventId=houston-2026';
const FIELDS = 'GET /api/fields?fieldSet=default';
const CONSENT = (country) => `GET /api/consent?country=${country}`;
const config = (modes) => ({ body: { modes, registrationMode: 'hybrid', fieldSet: 'default' } });
const ALL_MODES = config(['guest', 'otp', 'sso']);

// Each route is a queue of responses; the last one repeats. Config, fields and consent default.
function mockFetch(table) {
  routes = Object.fromEntries(Object.entries({
    [CONFIG]: ALL_MODES,
    [FIELDS]: { body: { fields: FIELD_DEFS } },
    [CONSENT('CR')]: consentFor('CR'),
    [CONSENT('DE')]: consentFor('DE'),
    ...table,
  }).map(([key, value]) => [key, [].concat(value)]));
}

const settle = (ms = 20) => new Promise((resolve) => { setTimeout(resolve, ms); });

window.fetch = async (url, opts = {}) => {
  const key = `${opts.method ?? 'GET'} ${url}`;
  calls.push({ key, opts, body: opts.body && JSON.parse(opts.body) });
  const queue = routes[key];
  const next = queue?.length > 1 ? queue.shift() : queue?.[0];
  if (next?.delay) { await settle(next.delay); }
  if (!next || next === 'network') { throw new TypeError('Failed to fetch'); }
  const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
  return new Response(next.status === 204 ? null : body, { status: next.status ?? 200 });
};

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
  for (const [name, value] of Object.entries(values)) {
    const control = form.elements.namedItem(name);
    control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

async function submit(form, values) {
  fill(form, values);
  form.requestSubmit();
  await settle();
}

const REGISTRATION = {
  firstName: 'Ana', lastName: 'Mora', email: 'ana@example.com', company: 'Acme', phone: '', country: 'CR',
};

// Fills the Register form, waits for consent, ticks the given boxes and submits.
async function register(form, values = REGISTRATION, accepted = ['terms']) {
  fill(form, values);
  await settle();
  accepted.forEach((id) => { form.elements.namedItem(id).checked = true; });
  form.requestSubmit();
  await settle();
}

async function click(el, text) {
  [...el.querySelectorAll('button')].find((b) => b.textContent === text).click();
  await settle();
  return el.querySelector('dialog');
}

const open = (el) => click(el, 'Register');
const buttons = (el) => [...el.querySelectorAll('.register-controls button')].map((b) => b.textContent);
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

function silenceConsole() {
  const logged = [];
  const original = { error: console.error, warn: console.warn, log: console.log };
  console.error = (...a) => logged.push(a);
  console.warn = console.error;
  console.log = console.error;
  return { logged, restore: () => Object.assign(console, original) };
}

describe('register: session restore', () => {
  it('fetches the session same-origin on load and shows Register', async () => {
    mockFetch({ 'GET /api/session': { body: ANON } });
    const el = await mount();
    expect(calls[0].key).to.equal('GET /api/session');
    expect(calls[0].opts.mode).to.equal('same-origin');
    expect(buttons(el)).to.deep.equal(['Register']);
  });

  it('shows the user and a Logout button when authenticated and registered', async () => {
    mockFetch({ 'GET /api/session': { body: ANA } });
    const el = await mount();
    expect(el.querySelector('.register-user').textContent).to.equal('Logged in as Ana');
    expect(buttons(el)).to.deep.equal(['Logout']);
  });

  it('adds Complete registration when authenticated but not registered for this event', async () => {
    mockFetch({ 'GET /api/session': { body: SSO_NEW } });
    const el = await mount();
    expect(el.querySelector('.register-user').textContent).to.equal('Logged in as Ana');
    expect(buttons(el)).to.deep.equal(['Complete registration', 'Logout']);
  });

  [
    ['404', { status: 404, body: 'Not found' }],
    ['a network error', 'network'],
    ['non-JSON', { body: '<html>oops</html>' }],
  ].forEach(([label, response]) => {
    it(`degrades to an unavailable message on ${label}`, async () => {
      const { logged, restore } = silenceConsole();
      try {
        mockFetch({ 'GET /api/session': response });
        const el = await mount();
        expect(buttons(el)).to.deep.equal(['Register']);
        const dialog = await open(el);
        expect(dialog.open).to.be.true;
        expect(dialog.querySelector('.register-unavailable').textContent)
          .to.equal('Registration is unavailable right now.');
        expect(dialog.querySelector('.register-content').hidden).to.be.true;
        expect(calls.map((c) => c.key).slice(0, 3)).to.deep.equal(['GET /api/session', 'GET /api/session', CONFIG]);
      } finally {
        restore();
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

describe('register: fields from the backend', () => {
  it('requests the field set encoded and renders each type with its label and required flag', async () => {
    const key = `GET /api/fields?fieldSet=${encodeURIComponent('a b&c=1')}`;
    mockFetch({
      'GET /api/session': { body: ANON },
      [CONFIG]: { body: { modes: ['guest'], fieldSet: 'a b&c=1' } },
      [key]: { body: { fields: FIELD_DEFS } },
    });
    const dialog = await open(await mount());
    expect(calls.find((c) => c.key === key).opts.mode).to.equal('same-origin');
    const form = dialog.querySelector('.register-form-register');
    const rendered = FIELD_DEFS.map(({ name }) => {
      const control = form.elements.namedItem(name);
      return [name, control.tagName, control.type, control.required, control.labels[0].textContent];
    });
    expect(rendered).to.deep.equal([
      ['firstName', 'INPUT', 'text', true, 'First name'],
      ['lastName', 'INPUT', 'text', true, 'Last name'],
      ['email', 'INPUT', 'email', true, 'Email'],
      ['company', 'INPUT', 'text', false, 'Company'],
      ['phone', 'INPUT', 'tel', false, 'Phone'],
      ['country', 'SELECT', 'select-one', true, 'Country'],
    ]);
    const { options } = form.elements.namedItem('country');
    expect([...options].map((o) => [o.value, o.textContent])).to.deep.equal([
      ['', 'Select an option'], ['DE', 'Germany'], ['US', 'United States'], ['CR', 'Costa Rica'],
    ]);
    const ids = [...form.querySelectorAll('input, select')].map((c) => c.id);
    expect(new Set(ids).size).to.equal(ids.length);
  });

  it('offers no Register form when the fields request fails, and retries on the next open', async () => {
    const { logged, restore } = silenceConsole();
    try {
      mockFetch({ 'GET /api/session': { body: ANON }, [FIELDS]: [{ status: 500 }, { body: { fields: FIELD_DEFS } }] });
      const el = await mount();
      const dialog = await open(el);
      expect(dialog.querySelectorAll('form')).to.have.length(1);
      expect(dialog.querySelector('.register-form-login')).to.exist;
      expect(dialog.querySelector('[role="tablist"]')).to.be.null;
      dialog.close();
      await open(el);
      expect(dialog.querySelector('.register-form-register')).to.exist;
    } finally {
      restore();
    }
    expect(logged).to.deep.equal([]);
  });

  it('shows unavailable when only guest is allowed and the fields request fails', async () => {
    mockFetch({ 'GET /api/session': { body: ANON }, [FIELDS]: { body: { nope: true } } });
    const dialog = await open(await mount({ registrationMode: 'guest' }));
    expect(dialog.querySelector('.register-unavailable').textContent).to.equal('Registration is unavailable right now.');
    expect(dialog.querySelector('form')).to.be.null;
  });

  it('prefills editable fields from session.profile[prefill]', async () => {
    mockFetch({ 'GET /api/session': { body: { ...SSO_NEW, readOnly: [] } } });
    const el = await mount();
    const dialog = await click(el, 'Complete registration');
    const form = dialog.querySelector('form');
    const firstName = form.elements.namedItem('firstName');
    expect(firstName.value).to.equal('Ana');
    expect(firstName.readOnly).to.be.false;
    expect(form.elements.namedItem('lastName').value, 'no prefill key, not read-only').to.equal('');
  });

  it('fills read-only fields from the profile, locks them and leaves them out of the POST', async () => {
    mockFetch({
      'GET /api/session': [{ body: SSO_NEW }, { body: { ...SSO_NEW, registeredEvents: ['houston-2026'] } }],
      'POST /api/register': { status: 201 },
    });
    const el = await mount();
    const dialog = await click(el, 'Complete registration');
    const form = dialog.querySelector('form');
    const email = form.elements.namedItem('email');
    const country = form.elements.namedItem('country');
    expect([email.value, email.readOnly]).to.deep.equal(['ana@example.com', true]);
    expect([country.value, country.disabled]).to.deep.equal(['CR', true]);
    expect(calls.some((c) => c.key === CONSENT('CR')), 'consent for the prefilled country').to.be.true;

    await register(form, { lastName: 'Mora', company: 'Acme' });
    const post = calls.find((c) => c.key === 'POST /api/register');
    expect(post.opts.headers['x-csrf-token']).to.equal('t4');
    expect(post.body).to.deep.equal({
      eventId: 'houston-2026',
      fields: { firstName: 'Ana', lastName: 'Mora', company: 'Acme', phone: '' },
      consent: { version: 'CR-v1', country: 'CR', accepted: ['terms'] },
    });
  });
});

describe('register: complete registration', () => {
  it('opens only the prefilled Register form, then thanks the user and updates the session', async () => {
    mockFetch({
      'GET /api/session': [{ body: SSO_NEW }, { body: { ...SSO_NEW, registeredEvents: ['houston-2026'] } }],
      'POST /api/register': { status: 201 },
    });
    const el = await mount({ registrationMode: 'sso' });
    const dialog = await click(el, 'Complete registration');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).to.equal('Complete registration');
    expect([...dialog.querySelectorAll('form')].map((f) => f.className)).to.deep.equal(['register-form-register']);
    expect(dialog.querySelector('[role="tablist"], .register-sso')).to.be.null;

    await register(dialog.querySelector('form'), { lastName: 'Mora', company: 'Acme' });
    expect(dialog.open).to.be.true;
    const thanks = dialog.querySelector('.register-thanks');
    expect(thanks.textContent).to.equal('Thank you, you are registered');
    expect(document.activeElement).to.equal(thanks);
    expect(buttons(el)).to.deep.equal(['Logout']);
    expect(events).to.deep.equal([{ authenticated: true, firstName: 'Ana' }]);

    await click(dialog, 'Close');
    expect(dialog.open).to.be.false;
    expect(document.activeElement.textContent, 'focus returns to the controls').to.equal('Logout');
  });
});

describe('register: consent', () => {
  beforeEach(() => mockFetch({ 'GET /api/session': { body: ANON } }));

  it('loads consent for the chosen country and renders text and labelled checkboxes', async () => {
    const dialog = await open(await mount());
    const form = dialog.querySelector('form');
    const consentBox = form.querySelector('.register-consent');
    expect(consentBox.hidden).to.be.true;
    fill(form, { country: 'CR' });
    await settle();
    expect(calls.find((c) => c.key === CONSENT('CR')).opts.mode).to.equal('same-origin');
    expect(consentBox.hidden).to.be.false;
    expect(consentBox.querySelector('legend').textContent).to.equal('Consent');
    expect(consentBox.querySelector('p').textContent).to.equal('Terms for CR.');
    const boxes = [...consentBox.querySelectorAll('input')].map((b) => [b.type, b.name, b.required, b.labels[0].textContent]);
    expect(boxes).to.deep.equal([
      ['checkbox', 'terms', true, 'I accept the terms'],
      ['checkbox', 'news', false, 'Send me news'],
    ]);
    expect(form.elements.namedItem('company').required, 'requiredFields').to.be.true;

    fill(form, { country: 'DE' });
    await settle();
    expect(consentBox.querySelector('p').textContent).to.equal('Terms for DE.');
    expect(form.elements.namedItem('company').required, 'back to the field default').to.be.false;

    fill(form, { country: '' });
    await settle();
    expect(consentBox.hidden).to.be.true;
  });

  it('encodes the country code', async () => {
    mockFetch({
      'GET /api/session': { body: ANON },
      [FIELDS]: { body: { fields: [{ name: 'country', type: 'text', label: 'Country', required: true }] } },
    });
    const dialog = await open(await mount());
    fill(dialog.querySelector('form'), { country: 'C R&x' });
    await settle();
    expect(calls.some((c) => c.key === `GET /api/consent?country=${encodeURIComponent('C R&x')}`)).to.be.true;
  });

  it('ignores a slow consent response for a country that is no longer selected', async () => {
    mockFetch({ 'GET /api/session': { body: ANON }, [CONSENT('CR')]: { ...consentFor('CR'), delay: 60 } });
    const dialog = await open(await mount());
    const form = dialog.querySelector('form');
    fill(form, { country: 'CR' });
    fill(form, { country: 'DE' });
    await settle(120);
    expect(form.querySelector('.register-consent p').textContent).to.equal('Terms for DE.');
  });

  it('sends version, country and the accepted checkbox ids next to eventId and fields', async () => {
    mockFetch({ 'GET /api/session': [{ body: ANON }, { body: ANON }], 'POST /api/register': { status: 201 } });
    const dialog = await open(await mount());
    await register(dialog.querySelector('form'));
    expect(calls.find((c) => c.key === 'POST /api/register').body).to.deep.equal({
      eventId: 'houston-2026',
      fields: REGISTRATION,
      consent: { version: 'CR-v1', country: 'CR', accepted: ['terms'] },
    });
  });

  it('does not submit before consent has loaded', async () => {
    mockFetch({ 'GET /api/session': { body: ANON }, [CONSENT('CR')]: { ...consentFor('CR'), delay: 200 } });
    const dialog = await open(await mount());
    const form = dialog.querySelector('form');
    fill(form, { ...REGISTRATION });
    form.requestSubmit();
    await settle();
    expect(calls.some((c) => c.key === 'POST /api/register')).to.be.false;
    expect(form.querySelector('.register-status').textContent)
      .to.equal('Please wait for the consent terms to load, then try again.');
  });

  it('says so when consent cannot be loaded', async () => {
    const { logged, restore } = silenceConsole();
    try {
      mockFetch({ 'GET /api/session': { body: ANON }, [CONSENT('CR')]: { status: 503 } });
      const dialog = await open(await mount());
      const form = dialog.querySelector('form');
      fill(form, { country: 'CR' });
      await settle();
      expect(form.querySelector('.register-status').textContent)
        .to.equal('Consent terms are unavailable right now. Please try again.');
      expect(form.querySelector('.register-consent').hidden).to.be.true;
    } finally {
      restore();
    }
    expect(logged).to.deep.equal([]);
  });

  it('shows a 422 for a checkbox id next to that checkbox', async () => {
    mockFetch({
      'GET /api/session': { body: ANON },
      'POST /api/register': { status: 422, body: { errors: { terms: 'You must accept the terms', email: 'Email is invalid' } } },
    });
    const dialog = await open(await mount());
    const form = dialog.querySelector('form');
    await register(form);
    const terms = form.elements.namedItem('terms');
    expect(terms.getAttribute('aria-invalid')).to.equal('true');
    expect(document.getElementById(terms.getAttribute('aria-describedby')).textContent).to.equal('You must accept the terms');
    expect(form.elements.namedItem('email').getAttribute('aria-invalid')).to.equal('true');
    expect(document.activeElement).to.equal(terms);
  });

  it('shows a general message and re-fetches consent on a consent 422', async () => {
    mockFetch({
      'GET /api/session': { body: ANON },
      [CONSENT('CR')]: [consentFor('CR'), consentFor('CR', { version: 'CR-v2' })],
      'POST /api/register': [
        { status: 422, body: { errors: { consent: 'The terms have changed.' } } },
        { status: 201 },
      ],
    });
    const dialog = await open(await mount());
    const form = dialog.querySelector('form');
    await register(form);
    expect(form.querySelector('.register-status').textContent).to.equal('The terms have changed.');
    expect(calls.filter((c) => c.key === CONSENT('CR'))).to.have.length(2);

    form.elements.namedItem('terms').checked = true;
    form.requestSubmit();
    await settle();
    expect(calls.filter((c) => c.key === 'POST /api/register').at(-1).body.consent.version).to.equal('CR-v2');
  });
});

describe('register: register tab', () => {
  it('posts with the CSRF token, refreshes the session and keeps the dialog open with thanks', async () => {
    mockFetch({ 'GET /api/session': [{ body: ANON }, { body: ANA }], 'POST /api/register': { status: 201 } });
    const el = await mount();
    const dialog = await open(el);
    await register(dialog.querySelector('form'));

    const post = calls.find((c) => c.key === 'POST /api/register');
    expect(post.opts.mode).to.equal('same-origin');
    expect(post.opts.headers['x-csrf-token']).to.equal('t1');
    expect(calls.at(-1).key).to.equal('GET /api/session');
    expect(dialog.open).to.be.true;
    expect(dialog.querySelector('.register-thanks').textContent).to.equal('Thank you, you are registered');
    expect(el.querySelector('.register-user').textContent).to.equal('Logged in as Ana');
    expect(events).to.deep.equal([{ authenticated: true, firstName: 'Ana' }]);
  });

  it('shows the form again, reset, the next time the dialog opens after thanks', async () => {
    mockFetch({ 'GET /api/session': [{ body: ANON }, { body: { ...ANON, csrfToken: 't5' } }], 'POST /api/register': { status: 201 } });
    const el = await mount();
    const dialog = await open(el);
    await register(dialog.querySelector('form'));
    await click(dialog, 'Close');
    await open(el);
    const form = dialog.querySelector('form');
    expect(form).to.exist;
    expect(form.elements.namedItem('firstName').value).to.equal('');
  });

  it('shows 422 errors next to each field', async () => {
    mockFetch({
      'GET /api/session': { body: ANON },
      'POST /api/register': { status: 422, body: { errors: { email: 'Email is invalid', country: 'Pick a country' } } },
    });
    const el = await mount();
    const dialog = await open(el);
    const form = dialog.querySelector('form');
    await register(form);

    for (const [name, text] of [['email', 'Email is invalid'], ['country', 'Pick a country']]) {
      const control = form.elements.namedItem(name);
      expect(control.getAttribute('aria-invalid')).to.equal('true');
      expect(document.getElementById(control.getAttribute('aria-describedby')).textContent).to.equal(text);
    }
    expect(form.elements.namedItem('firstName').hasAttribute('aria-invalid')).to.be.false;
    expect(document.activeElement).to.equal(form.elements.namedItem('email'));
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
      await register(form);
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

  it('offers Complete registration after logging in when not registered for the event', async () => {
    mockFetch({
      'GET /api/session': [{ body: ANON }, { body: { ...ANA, registeredEvents: [] } }],
      'POST /api/otp/request': { status: 204 },
      'POST /api/otp/verify': { status: 200 },
    });
    const el = await mount();
    const dialog = await open(el);
    const form = dialog.querySelector('.register-form-login');
    await submit(form, { email: 'ana@example.com' });
    await submit(form, { code: '123456' });
    expect(buttons(el)).to.deep.equal(['Complete registration', 'Logout']);
    expect(document.activeElement.textContent).to.equal('Complete registration');
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
    await click(el, 'Logout');

    const logout = calls.find((c) => c.key === 'POST /api/logout');
    expect(logout.opts.headers['x-csrf-token']).to.equal('t2');
    expect(calls.at(-1).key).to.equal('GET /api/session');
    expect(buttons(el)).to.deep.equal(['Register']);
    expect(events).to.deep.equal([{ authenticated: false, firstName: undefined }]);

    const dialog = await open(el);
    await register(dialog.querySelector('form'));
    expect(calls.at(-1).opts.headers['x-csrf-token']).to.equal('t3');
  });

  it('keeps the logged-in state and shows a message when logout fails', async () => {
    mockFetch({ 'GET /api/session': { body: ANA }, 'POST /api/logout': { status: 401 } });
    const el = await mount();
    await click(el, 'Logout');
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
    mockFetch({ 'GET /api/session': { body: ANON }, [CONFIG]: config(['guest', 'otp']) });
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
      mockFetch({ 'GET /api/session': { body: ANON }, [CONFIG]: config(modes) });
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
      const { logged, restore } = silenceConsole();
      try {
        mockFetch({ 'GET /api/session': { body: ANON }, [CONFIG]: [response, ALL_MODES] });
        const el = await mount();
        const dialog = await open(el);
        expect(view(dialog)).to.deep.equal({ tabs: [], forms: [], sso: null, unavailable: 'Registration is unavailable right now.' });
        expect(buttons(el)).to.deep.equal(['Register']);

        dialog.close();
        await open(el);
        expect(view(dialog).forms, 'retries on the next open').to.deep.equal([REG, LOGIN]);
      } finally {
        restore();
      }
      expect(logged).to.deep.equal([]);
    });
  });

  it('shows unavailable for Complete registration when event config fails', async () => {
    mockFetch({ 'GET /api/session': { body: SSO_NEW }, [CONFIG]: { status: 404 } });
    const dialog = await click(await mount(), 'Complete registration');
    expect(view(dialog)).to.deep.equal({ tabs: [], forms: [], sso: null, unavailable: 'Registration is unavailable right now.' });
  });

  it('fetches the config and fields once and reuses them', async () => {
    mockFetch({ 'GET /api/session': { body: ANON } });
    const el = await mount();
    const dialog = await open(el);
    dialog.close();
    await open(el);
    expect(calls.filter((c) => c.key === CONFIG)).to.have.length(1);
    expect(calls.filter((c) => c.key === FIELDS)).to.have.length(1);
  });
});
