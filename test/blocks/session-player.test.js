import { expect } from '@esm-bundle/chai';
import init from '../../blocks/session-player/session-player.js';

const realFetch = window.fetch;
const realSearch = window.location.search;
const mounted = [];
const urls = [];
let routes = {};
let calls = [];
let required = 0;
let htmlWrites = 0;
let storageWrites = 0;

const settle = (ms = 20) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A media URL that attaches without erroring and never finishes loading.
function mediaUrl() {
  const url = URL.createObjectURL(new MediaSource());
  urls.push(url);
  return url;
}

const TOKEN = (eventId = 'houston-2026', sessionId = 's1') => `GET /api/media-token?eventId=${encodeURIComponent(eventId)}&sessionId=${encodeURIComponent(sessionId)}`;

// Each route is a queue of responses; the last one repeats. Functions run per request.
function mockFetch(table) {
  routes = Object.fromEntries(Object.entries(table).map(([key, value]) => [key, [].concat(value)]));
}

window.fetch = async (url, opts = {}) => {
  const key = `${opts.method ?? 'GET'} ${url}`;
  calls.push({ key, opts });
  const queue = routes[key];
  const queued = queue?.length > 1 ? queue.shift() : queue?.[0];
  const next = typeof queued === 'function' ? queued() : queued;
  if (next?.delay) { await settle(next.delay); }
  if (!next || next === 'network') { throw new TypeError('Failed to fetch'); }
  const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
  return new Response(body, { status: next.status ?? 200 });
};

const ok = (url = mediaUrl()) => ({ body: { url } });
// A MediaSource attaches only once, so repeated responses need a fresh URL each time.
const fresh = () => ok();

async function mount({ cell = 's1', eventId = 'houston-2026', wait = true } = {}) {
  const meta = document.createElement('meta');
  Object.assign(meta, { name: 'event-id', content: eventId });
  document.head.append(meta);
  const el = document.createElement('div');
  el.className = 'session-player';
  const row = document.createElement('div');
  const col = document.createElement('div');
  col.textContent = cell;
  row.append(col);
  el.append(row);
  document.body.append(el);
  mounted.push(meta, el);
  init(el);
  if (wait) { await settle(); }
  return el;
}

const view = (el) => ({
  message: el.querySelector('.session-player-message')?.textContent ?? null,
  button: el.querySelector('.session-player-button')?.textContent ?? null,
  video: Boolean(el.querySelector('video')),
  status: el.querySelector('.session-player-status').textContent,
});

// Media that never loads keeps its seek position across a src change, so tests record the seeks.
function trackSeeks(video, start) {
  let time = start;
  const seeks = [];
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value) => { seeks.push([video.src, value]); time = value; },
  });
  return seeks;
}

const changed = async () => {
  document.dispatchEvent(new CustomEvent('session:changed', { detail: {} }));
  await settle();
};

const onRequired = () => { required += 1; };

before(async () => {
  await new Promise((resolve) => {
    const link = document.createElement('link');
    Object.assign(link, { rel: 'stylesheet', href: '/blocks/session-player/session-player.css', onload: resolve });
    document.head.append(link);
  });
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
  urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  window.history.replaceState(null, '', `${window.location.pathname}${realSearch}`);
  expect(htmlWrites, 'no HTML string sinks').to.equal(0);
  expect(storageWrites, 'no web storage writes').to.equal(0);
});

describe('session-player: locked state', () => {
  it('renders the locked 16:9 box straight away, before the token arrives', async () => {
    mockFetch({ [TOKEN()]: { ...ok(), delay: 200 } });
    const el = await mount({ wait: false });
    expect(view(el)).to.deep.equal({ message: 'Login to view this video', button: 'Login', video: false, status: '' });
    const frame = el.querySelector('.session-player-frame');
    expect(getComputedStyle(frame).aspectRatio).to.equal('16 / 9');
    expect(el.querySelector('.session-player-status').getAttribute('aria-live')).to.equal('polite');
  });

  it('dispatches login:required on document from the Login button', async () => {
    mockFetch({ [TOKEN()]: { status: 401 } });
    const el = await mount();
    el.querySelector('.session-player-button').click();
    expect(required).to.equal(1);
  });

  it('stays locked on 401 without announcing anything', async () => {
    mockFetch({ [TOKEN()]: { status: 401 } });
    const el = await mount();
    expect(view(el)).to.deep.equal({ message: 'Login to view this video', button: 'Login', video: false, status: '' });
  });
});

describe('session-player: token request', () => {
  it('requests the token same-origin with encoded event and session ids', async () => {
    const key = TOKEN('hou ston&x', 's/1?b=2');
    mockFetch({ [key]: { status: 401 } });
    await mount({ eventId: 'hou ston&x', cell: '  s/1?b=2  ' });
    expect(calls.map((c) => c.key)).to.deep.equal([key]);
    expect(calls[0].opts.mode).to.equal('same-origin');
    expect(calls[0].opts.cache).to.equal('no-store');
  });

  it('falls back to the session query parameter when the cell is empty', async () => {
    window.history.replaceState(null, '', `${window.location.pathname}?session=q%2042`);
    mockFetch({ [TOKEN('houston-2026', 'q 42')]: { status: 401 } });
    await mount({ cell: '' });
    expect(calls.map((c) => c.key)).to.deep.equal([TOKEN('houston-2026', 'q 42')]);
  });

  it('shows no video and makes no request without a session id', async () => {
    mockFetch({});
    const el = await mount({ cell: '' });
    expect(calls).to.deep.equal([]);
    expect(view(el)).to.deep.equal({ message: 'No video for this session', button: null, video: false, status: '' });
  });
});

describe('session-player: responses', () => {
  it('replaces the box with a video on 200 and announces it', async () => {
    const url = mediaUrl();
    mockFetch({ [TOKEN()]: ok(url) });
    const el = await mount();
    const video = el.querySelector('video');
    expect([video.controls, video.playsInline, video.preload, video.src]).to.deep.equal([true, true, 'metadata', url]);
    expect(video.getAttribute('aria-label')).to.equal('Session video');
    expect(view(el)).to.deep.equal({ message: null, button: null, video: true, status: 'Video unlocked' });
  });

  it('asks to register on 403, and its button dispatches login:required', async () => {
    mockFetch({ [TOKEN()]: { status: 403 } });
    const el = await mount();
    expect(view(el)).to.deep.equal({
      message: 'Register for this event to watch',
      button: 'Complete registration',
      video: false,
      status: 'Register for this event to watch',
    });
    el.querySelector('.session-player-button').click();
    expect(required).to.equal(1);
  });

  it('says there is no video on 404', async () => {
    mockFetch({ [TOKEN()]: { status: 404 } });
    const el = await mount();
    expect(view(el)).to.deep.equal({ message: 'No video for this session', button: null, video: false, status: 'No video for this session' });
  });

  [
    ['500', { status: 500 }],
    ['a network error', 'network'],
    ['non-JSON', { body: '<html>' }],
    ['a response without url', { body: { token: 'x' } }],
  ].forEach(([label, response]) => {
    it(`says the video is unavailable on ${label}, without logging`, async () => {
      const logged = [];
      const original = { error: console.error, warn: console.warn, log: console.log };
      console.error = (...a) => logged.push(a);
      console.warn = console.error;
      console.log = console.error;
      try {
        mockFetch({ [TOKEN()]: response });
        const el = await mount();
        expect(view(el).message).to.equal('This video is unavailable right now.');
        expect(view(el).button).to.be.null;
      } finally {
        Object.assign(console, original);
      }
      expect(logged).to.deep.equal([]);
    });
  });
});

describe('session-player: session:changed', () => {
  it('requests a new token and unlocks, then locks again on logout', async () => {
    mockFetch({ [TOKEN()]: [{ status: 401 }, ok(), { status: 401 }] });
    const el = await mount();
    await changed();
    const video = el.querySelector('video');
    expect(video).to.exist;
    await changed();
    expect(view(el)).to.deep.equal({ message: 'Login to view this video', button: 'Login', video: false, status: 'Login to view this video' });
    expect(video.hasAttribute('src'), 'the URL is dropped').to.be.false;
    expect(calls).to.have.length(3);
  });

  it('keeps the same video and position when the new token is also valid', async () => {
    const second = mediaUrl();
    mockFetch({ [TOKEN()]: [ok(), ok(second)] });
    const el = await mount();
    const video = el.querySelector('video');
    const seeks = trackSeeks(video, 42);
    await changed();
    expect(el.querySelector('video')).to.equal(video);
    expect(video.src).to.equal(second);
    expect(seeks, 'seeks back after the new src').to.deep.equal([[second, 42]]);
  });

  it('ignores a slow response that a newer request has overtaken', async () => {
    mockFetch({ [TOKEN()]: [{ status: 401 }, { ...ok(), delay: 80 }, { status: 403 }] });
    const el = await mount();
    document.dispatchEvent(new CustomEvent('session:changed'));
    await changed();
    await settle(120);
    expect(view(el).message).to.equal('Register for this event to watch');
    expect(view(el).video).to.be.false;
  });

  it('moves focus to the video when the focused Login button is replaced', async () => {
    mockFetch({ [TOKEN()]: [{ status: 401 }, ok()] });
    const el = await mount();
    el.querySelector('.session-player-button').focus();
    await changed();
    expect(document.activeElement).to.equal(el.querySelector('video'));
  });
});

describe('session-player: playback errors', () => {
  it('requests a new token once and resumes from the same time', async () => {
    const second = mediaUrl();
    mockFetch({ [TOKEN()]: [ok(), ok(second)] });
    const el = await mount();
    const video = el.querySelector('video');
    video.muted = true;
    const seeks = trackSeeks(video, 30);
    video.play().catch(() => {});
    video.dispatchEvent(new Event('error'));
    await settle();
    expect(calls).to.have.length(2);
    expect([video.src, video.paused]).to.deep.equal([second, false]);
    expect(seeks, 'resumes from the same time').to.deep.equal([[second, 30]]);
    expect(el.querySelector('video')).to.equal(video);
  });

  it('returns to the locked state when the new token is refused', async () => {
    mockFetch({ [TOKEN()]: [ok(), { status: 403 }] });
    const el = await mount();
    el.querySelector('video').dispatchEvent(new Event('error'));
    await settle();
    expect(view(el)).to.deep.equal({ message: 'Login to view this video', button: 'Login', video: false, status: 'Login to view this video' });
  });

  it('locks when the new URL fails too, without asking again', async () => {
    mockFetch({ [TOKEN()]: fresh });
    const el = await mount();
    const video = el.querySelector('video');
    video.dispatchEvent(new Event('error'));
    await settle();
    video.dispatchEvent(new Event('error'));
    await settle();
    expect(calls).to.have.length(2);
    expect(view(el).message).to.equal('Login to view this video');
  });

  it('can recover again once the new URL has loaded', async () => {
    mockFetch({ [TOKEN()]: fresh });
    const el = await mount();
    const video = el.querySelector('video');
    video.dispatchEvent(new Event('error'));
    await settle();
    video.dispatchEvent(new Event('loadeddata'));
    video.dispatchEvent(new Event('error'));
    await settle();
    expect(calls).to.have.length(3);
    expect(view(el).video).to.be.true;
  });
});
