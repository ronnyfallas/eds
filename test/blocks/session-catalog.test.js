import { expect } from '@esm-bundle/chai';
import init from '../../blocks/session-catalog/session-catalog.js';

const realFetch = window.fetch;
const mounted = [];
let routes = {};
let calls = [];
let required = 0;
let htmlWrites = 0;
let storageWrites = 0;
let inflight = 0;

const settle = (ms = 20) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Waits until no mocked request has been in flight for a few polls; the block chains several.
async function until(ready, ms = 1000) {
  for (let waited = 0; !ready() && waited < ms; waited += 10) { await settle(10); }
}

async function idle() {
  for (let quiet = 0, waited = 0; quiet < 3 && waited < 2000; waited += 10) {
    await settle(10);
    quiet = inflight ? 0 : quiet + 1;
  }
}

const CATALOG = '/test/blocks/sessions.json';
const SESSIONS = [
  {
    id: 's1',
    title: 'Opening keynote',
    track: 'Main stage',
    start: '2027-03-12T15:00:00Z',
    end: '2027-03-12T16:00:00Z',
    speaker: 'Ana Mora',
    videoId: 'v1',
    gated: true,
  },
  {
    id: 's2',
    title: 'Workshop: blocks',
    track: 'Hands-on',
    start: '2027-03-12T17:00:00Z',
    end: '2027-03-12T18:30:00Z',
    speaker: 'Luis Vega',
    videoId: '',
    gated: false,
  },
  {
    id: 's3', title: 'Closing', track: 'Main stage', start: '2027-03-14T20:00:00Z', end: '', speaker: '', videoId: 'v3',
  },
  { id: 'a b&c', title: 'Odd id', start: 'not a date' },
  { title: 'No id, skipped' },
];
const ANON = { authenticated: false, csrfToken: 't1' };
const USER = { authenticated: true, csrfToken: 't2' };
const SCHEDULE = 'GET /api/schedule?eventId=houston-2026';
const FAVORITES = 'GET /api/favorites?eventId=houston-2026';

// Each route is a queue of responses; the last one repeats.
function mockFetch(table) {
  routes = Object.fromEntries(Object.entries({
    [`GET ${CATALOG}`]: { body: { data: SESSIONS } },
    [SCHEDULE]: { body: { sessionIds: [] } },
    [FAVORITES]: { body: { sessionIds: [] } },
    ...table,
  }).map(([key, value]) => [key, [].concat(value)]));
}

async function respond(url, opts) {
  const { origin } = window.location;
  const path = url.startsWith(origin) ? url.slice(origin.length) : url;
  const key = `${opts.method ?? 'GET'} ${path}`;
  calls.push({ key, opts, body: opts.body && JSON.parse(opts.body) });
  const queue = routes[key];
  const next = queue?.length > 1 ? queue.shift() : queue?.[0];
  if (next?.delay) { await settle(next.delay); }
  if (!next || next === 'network') { throw new TypeError('Failed to fetch'); }
  const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
  return new Response(next.status === 204 ? null : body, { status: next.status ?? 200 });
}

window.fetch = async (url, opts = {}) => {
  inflight += 1;
  try {
    return await respond(url, opts);
  } finally {
    inflight -= 1;
  }
};

async function mount({ href = CATALOG, page, wait = true } = {}) {
  const meta = document.createElement('meta');
  Object.assign(meta, { name: 'event-id', content: 'houston-2026' });
  document.head.append(meta);
  const el = document.createElement('div');
  el.className = 'session-catalog';
  const cell = (child) => {
    const row = document.createElement('div');
    const col = document.createElement('div');
    col.append(child);
    row.append(col);
    return row;
  };
  const link = document.createElement('a');
  Object.assign(link, { href, textContent: 'sessions' });
  el.append(cell(link));
  if (page !== undefined) { el.append(cell(page)); }
  document.body.append(el);
  mounted.push(meta, el);
  init(el);
  if (wait) { await idle(); }
  return el;
}

const sessionEl = (el, title) => [...el.querySelectorAll('.session-catalog-session')]
  .find((li) => li.querySelector('.session-catalog-title').textContent === title);
const button = (el, title, kind) => sessionEl(el, title).querySelector(`.session-catalog-${kind}`);
const pressed = (el, title, kind) => button(el, title, kind).getAttribute('aria-pressed');
const message = (el, title) => sessionEl(el, title).querySelector('.session-catalog-message');
const keys = () => calls.map((c) => c.key);
const changed = async (authenticated) => {
  document.dispatchEvent(new CustomEvent('session:changed', { detail: { authenticated } }));
  await idle();
};
const onRequired = () => { required += 1; };

before(() => {
  ['innerHTML', 'outerHTML'].forEach((prop) => {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    Object.defineProperty(Element.prototype, prop, {
      ...desc,
      set(value) { htmlWrites += 1; desc.set.call(this, value); },
    });
  });
  const { setItem } = Storage.prototype;
  Storage.prototype.setItem = function spy(...args) {
    storageWrites += 1;
    return setItem.apply(this, args);
  };
});

after(() => { window.fetch = realFetch; });

beforeEach(() => {
  calls = [];
  required = 0;
  document.addEventListener('login:required', onRequired);
});

afterEach(() => {
  document.removeEventListener('login:required', onRequired);
  mounted.splice(0).forEach((node) => node.remove());
  expect(htmlWrites, 'no HTML string sinks').to.equal(0);
  expect(storageWrites, 'no web storage writes').to.equal(0);
});

describe('session-catalog: listing', () => {
  it('fetches the linked JSON same-origin and groups sessions by track', async () => {
    mockFetch({ 'GET /api/session': { body: ANON } });
    const el = await mount();
    expect(calls.find((c) => c.key === `GET ${CATALOG}`).opts.mode).to.equal('same-origin');
    const tracks = [...el.querySelectorAll('.session-catalog-track')].map((t) => [
      t.querySelector('h3').textContent,
      [...t.querySelectorAll('.session-catalog-title')].map((h) => h.textContent),
    ]);
    expect(tracks).to.deep.equal([
      ['Main stage', ['Opening keynote', 'Closing']],
      ['Hands-on', ['Workshop: blocks']],
      ['Other', ['Odd id']],
    ]);
  });

  it('shows local date and time with Intl.DateTimeFormat, and the speaker', async () => {
    mockFetch({ 'GET /api/session': { body: ANON } });
    const el = await mount();
    const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const time = sessionEl(el, 'Opening keynote').querySelector('time');
    expect(time.getAttribute('datetime')).to.equal('2027-03-12T15:00:00.000Z');
    const [first] = SESSIONS;
    expect(time.textContent).to.equal(fmt.formatRange(new Date(first.start), new Date(first.end)));
    expect(sessionEl(el, 'Closing').querySelector('time').textContent, 'no end').to.equal(fmt.format(new Date(SESSIONS[2].start)));
    expect(Boolean(sessionEl(el, 'Odd id').querySelector('time')), 'invalid date').to.be.false;
    expect(sessionEl(el, 'Opening keynote').querySelector('.session-catalog-speaker').textContent).to.equal('Ana Mora');
    expect(Boolean(sessionEl(el, 'Closing').querySelector('.session-catalog-speaker'))).to.be.false;
  });

  it('links the title to the session page only when there is a video', async () => {
    mockFetch({ 'GET /api/session': { body: ANON } });
    const el = await mount();
    expect(sessionEl(el, 'Opening keynote').querySelector('a').getAttribute('href')).to.equal('/session?session=s1');
    expect(Boolean(sessionEl(el, 'Workshop: blocks').querySelector('a'))).to.be.false;
  });

  it('uses the session page from row 2 and encodes the id', async () => {
    mockFetch({
      'GET /api/session': { body: ANON },
      [`GET ${CATALOG}`]: { body: { data: [{ id: 'a b&c', title: 'Odd', videoId: 'v' }] } },
    });
    const el = await mount({ page: ' /watch ' });
    expect(el.querySelector('.session-catalog-title a').getAttribute('href')).to.equal(`/watch?session=${encodeURIComponent('a b&c')}`);
  });

  it('renders toggle buttons with aria-pressed, described by the session title', async () => {
    mockFetch({ 'GET /api/session': { body: ANON } });
    const el = await mount();
    for (const kind of ['schedule', 'favorites']) {
      const b = button(el, 'Opening keynote', kind);
      expect(b.getAttribute('aria-pressed'), kind).to.equal('false');
      expect(document.getElementById(b.getAttribute('aria-describedby')).textContent).to.equal('Opening keynote');
    }
    expect(button(el, 'Opening keynote', 'schedule').textContent).to.equal('Add to schedule');
    expect(button(el, 'Opening keynote', 'favorites').textContent).to.equal('Favorite');
    expect(message(el, 'Opening keynote').getAttribute('aria-live')).to.equal('polite');
  });

  [
    ['a cross-origin link', { href: 'https://example.com/sessions.json' }, {}],
    ['a 404', {}, { [`GET ${CATALOG}`]: { status: 404 } }],
    ['non-JSON', {}, { [`GET ${CATALOG}`]: { body: '<html>' } }],
    ['JSON without data', {}, { [`GET ${CATALOG}`]: { body: { rows: [] } } }],
  ].forEach(([label, opts, table]) => {
    it(`says sessions are unavailable on ${label}, without logging`, async () => {
      const logged = [];
      const original = { error: console.error, warn: console.warn, log: console.log };
      console.error = (...a) => logged.push(a);
      console.warn = console.error;
      console.log = console.error;
      try {
        mockFetch({ 'GET /api/session': { body: ANON }, ...table });
        const el = await mount(opts);
        expect(el.textContent).to.equal('Sessions are unavailable right now.');
        expect(keys().some((k) => k.includes('example.com')), 'no cross-origin request').to.be.false;
      } finally {
        Object.assign(console, original);
      }
      expect(logged).to.deep.equal([]);
    });
  });
});

describe('session-catalog: initial state', () => {
  it('loads schedule and favorites when authenticated, so buttons show their state', async () => {
    mockFetch({
      'GET /api/session': { body: USER },
      [SCHEDULE]: { body: { sessionIds: ['s1'] } },
      [FAVORITES]: { body: { sessionIds: ['s2', 's1'] } },
    });
    const el = await mount();
    expect(calls.find((c) => c.key === SCHEDULE).opts.mode).to.equal('same-origin');
    const both = (title) => [pressed(el, title, 'schedule'), pressed(el, title, 'favorites')];
    expect(both('Opening keynote')).to.deep.equal(['true', 'true']);
    expect(both('Workshop: blocks')).to.deep.equal(['false', 'true']);
  });

  it('does not ask for schedule or favorites when not authenticated', async () => {
    mockFetch({ 'GET /api/session': { body: ANON } });
    await mount();
    expect(keys().filter((k) => k.includes('/api/schedule') || k.includes('/api/favorites'))).to.deep.equal([]);
  });
});

describe('session-catalog: toggling', () => {
  it('adds with POST and removes with DELETE, sending the CSRF token', async () => {
    mockFetch({
      'GET /api/session': { body: USER },
      'POST /api/schedule': { status: 201 },
      'DELETE /api/schedule?eventId=houston-2026&sessionId=s2': { status: 204 },
    });
    const el = await mount();
    button(el, 'Workshop: blocks', 'schedule').click();
    await idle();
    const post = calls.find((c) => c.key === 'POST /api/schedule');
    expect(post.opts.mode).to.equal('same-origin');
    expect(post.opts.headers).to.deep.equal({ 'x-csrf-token': 't2', 'content-type': 'application/json' });
    expect(post.body).to.deep.equal({ eventId: 'houston-2026', sessionId: 's2' });
    expect(pressed(el, 'Workshop: blocks', 'schedule')).to.equal('true');

    button(el, 'Workshop: blocks', 'schedule').click();
    await idle();
    const del = calls.find((c) => c.key.startsWith('DELETE'));
    expect(del.opts.headers).to.deep.equal({ 'x-csrf-token': 't2' });
    expect(del.opts.body).to.be.undefined;
    expect(pressed(el, 'Workshop: blocks', 'schedule')).to.equal('false');
  });

  it('toggles favorites the same way, with encoded ids', async () => {
    const del = `DELETE /api/favorites?eventId=houston-2026&sessionId=${encodeURIComponent('a b&c')}`;
    mockFetch({
      'GET /api/session': { body: USER },
      [FAVORITES]: { body: { sessionIds: ['a b&c'] } },
      [del]: { status: 204 },
    });
    const el = await mount();
    expect(pressed(el, 'Odd id', 'favorites')).to.equal('true');
    button(el, 'Odd id', 'favorites').click();
    await idle();
    expect(keys()).to.include(del);
    expect(pressed(el, 'Odd id', 'favorites')).to.equal('false');
  });

  it('asks for login when not authenticated, then performs the action after login', async () => {
    mockFetch({
      'GET /api/session': [{ body: ANON }, { body: { ...USER, csrfToken: 't9' } }],
      'POST /api/favorites': { status: 201 },
    });
    const el = await mount();
    button(el, 'Closing', 'favorites').click();
    await idle();
    expect(required).to.equal(1);
    expect(keys().some((k) => k.startsWith('POST'))).to.be.false;

    await changed(true);
    const post = calls.find((c) => c.key === 'POST /api/favorites');
    expect(post.opts.headers['x-csrf-token'], 'token from the new session').to.equal('t9');
    expect(post.body).to.deep.equal({ eventId: 'houston-2026', sessionId: 's3' });
    expect(pressed(el, 'Closing', 'favorites')).to.equal('true');
  });

  it('skips the pending action when the loaded state already matches it', async () => {
    mockFetch({
      'GET /api/session': [{ body: ANON }, { body: USER }],
      [FAVORITES]: { body: { sessionIds: ['s3'] } },
    });
    const el = await mount();
    button(el, 'Closing', 'favorites').click();
    await changed(true);
    expect(keys().some((k) => k.startsWith('POST') || k.startsWith('DELETE'))).to.be.false;
    expect(pressed(el, 'Closing', 'favorites')).to.equal('true');
  });

  it('keeps the pending action while session:changed reports not authenticated', async () => {
    mockFetch({
      'GET /api/session': [{ body: ANON }, { body: ANON }, { body: USER }],
      'POST /api/schedule': { status: 201 },
    });
    const el = await mount();
    button(el, 'Closing', 'schedule').click();
    await changed(false);
    expect(keys().some((k) => k.startsWith('POST'))).to.be.false;
    await changed(true);
    expect(keys()).to.include('POST /api/schedule');
    expect(pressed(el, 'Closing', 'schedule')).to.equal('true');
  });

  it('clears the pressed states on logout', async () => {
    mockFetch({
      'GET /api/session': [{ body: USER }, { body: ANON }],
      [SCHEDULE]: { body: { sessionIds: ['s1'] } },
    });
    const el = await mount();
    expect(pressed(el, 'Opening keynote', 'schedule')).to.equal('true');
    await changed(false);
    expect(pressed(el, 'Opening keynote', 'schedule')).to.equal('false');
  });
});

describe('session-catalog: ordering', () => {
  it('waits for the session before deciding, so an early click by a logged-in user is not a login prompt', async () => {
    mockFetch({ 'GET /api/session': { body: USER, delay: 80 }, 'POST /api/schedule': { status: 201 } });
    const el = await mount({ wait: false });
    await until(() => el.querySelector('.session-catalog-session'));
    button(el, 'Closing', 'schedule').click();
    await idle();
    expect(required).to.equal(0);
    expect(keys()).to.include('POST /api/schedule');
    expect(pressed(el, 'Closing', 'schedule')).to.equal('true');
  });

  it('does not let a slow list response undo a newer change', async () => {
    mockFetch({
      'GET /api/session': { body: USER },
      [SCHEDULE]: { body: { sessionIds: [] }, delay: 80 },
      'POST /api/schedule': { status: 201 },
    });
    const el = await mount({ wait: false });
    await until(() => el.querySelector('.session-catalog-session'));
    button(el, 'Closing', 'schedule').click();
    await idle();
    expect(pressed(el, 'Closing', 'schedule')).to.equal('true');
  });

  it('sends one request for a quick double click', async () => {
    mockFetch({ 'GET /api/session': { body: USER }, 'POST /api/schedule': { status: 201, delay: 40 } });
    const el = await mount();
    button(el, 'Closing', 'schedule').click();
    button(el, 'Closing', 'schedule').click();
    await idle();
    expect(keys().filter((k) => k === 'POST /api/schedule')).to.have.length(1);
    expect(pressed(el, 'Closing', 'schedule')).to.equal('true');
  });
});

describe('session-catalog: errors', () => {
  it('asks to register on a schedule 403, and retries after session:changed', async () => {
    mockFetch({
      'GET /api/session': { body: USER },
      'POST /api/schedule': [{ status: 403 }, { status: 201 }],
    });
    const el = await mount();
    button(el, 'Opening keynote', 'schedule').click();
    await idle();
    expect(message(el, 'Opening keynote').textContent).to.equal('Register for this event first');
    expect(required).to.equal(1);
    expect(pressed(el, 'Opening keynote', 'schedule')).to.equal('false');

    await changed(true);
    expect(keys().filter((k) => k === 'POST /api/schedule')).to.have.length(2);
    expect(pressed(el, 'Opening keynote', 'schedule')).to.equal('true');
    expect(message(el, 'Opening keynote').textContent).to.equal('');
  });

  it('shows the overlap message in that session\'s live region on 409', async () => {
    mockFetch({ 'GET /api/session': { body: USER }, 'POST /api/schedule': { status: 409 } });
    const el = await mount();
    button(el, 'Workshop: blocks', 'schedule').click();
    await idle();
    expect(message(el, 'Workshop: blocks').textContent).to.equal('This overlaps with a session already in your schedule');
    expect(message(el, 'Opening keynote').textContent).to.equal('');
    expect(pressed(el, 'Workshop: blocks', 'schedule')).to.equal('false');
    expect(required).to.equal(0);
  });

  it('asks for login and keeps the action on 401', async () => {
    mockFetch({
      'GET /api/session': { body: USER },
      'POST /api/favorites': [{ status: 401 }, { status: 201 }],
    });
    const el = await mount();
    button(el, 'Closing', 'favorites').click();
    await idle();
    expect(required).to.equal(1);
    await changed(true);
    expect(pressed(el, 'Closing', 'favorites')).to.equal('true');
  });

  [
    ['a favorites 403', 'favorites', 403],
    ['a favorites 409', 'favorites', 409],
    ['a 500', 'schedule', 500],
    ['a network error', 'schedule', 'network'],
  ].forEach(([label, kind, status]) => {
    it(`shows a generic message for ${label}`, async () => {
      mockFetch({
        'GET /api/session': { body: USER },
        [`POST /api/${kind}`]: status === 'network' ? 'network' : { status },
      });
      const el = await mount();
      button(el, 'Closing', kind).click();
      await idle();
      expect(message(el, 'Closing').textContent).to.equal('Something went wrong. Please try again.');
      expect(required).to.equal(0);
    });
  });
});
