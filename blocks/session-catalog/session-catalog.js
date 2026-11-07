import { getMetadata } from '../../scripts/ak.js';

const KINDS = {
  schedule: { label: 'Add to schedule', path: '/api/schedule' },
  favorites: { label: 'Favorite', path: '/api/favorites' },
};

const MESSAGES = {
  register: 'Register for this event first',
  overlap: 'This overlaps with a session already in your schedule',
  error: 'Something went wrong. Please try again.',
  unavailable: 'Sessions are unavailable right now.',
};

const FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

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

async function getJson(url, valid, opts = {}) {
  try {
    const res = await fetch(url, { mode: 'same-origin', ...opts });
    if (!res.ok) { return null; }
    const data = await res.json();
    return valid(data) ? data : null;
  } catch {
    return null;
  }
}

const getSession = () => getJson('/api/session', (s) => typeof s?.csrfToken === 'string', { cache: 'no-store' });

const getIds = async (kind, eventId) => {
  const data = await getJson(
    `${KINDS[kind].path}?eventId=${encodeURIComponent(eventId)}`,
    (d) => Array.isArray(d?.sessionIds),
    { cache: 'no-store' },
  );
  return new Set(data?.sessionIds ?? []);
};

function when(start, end) {
  const from = new Date(start);
  if (Number.isNaN(from.valueOf())) { return null; }
  const to = new Date(end);
  const text = Number.isNaN(to.valueOf()) ? FORMAT.format(from) : FORMAT.formatRange(from, to);
  return tag('time', { datetime: from.toISOString(), text });
}

export default function init(el) {
  const prefix = `session-catalog-${count += 1}`;
  const rows = [...el.querySelectorAll(':scope > div')];
  const source = rows[0]?.querySelector('a')?.href;
  const sessionPage = rows[1]?.textContent.trim() || '/session';
  const eventId = getMetadata('event-id') ?? '';

  let session = null;
  let pending = null;
  const state = { schedule: new Set(), favorites: new Set() };
  const toggles = [];
  const messages = new Map();
  // Loads and toggles run one at a time, so a slow list can't overwrite a newer change.
  let queue = Promise.resolve();
  const serial = (task) => {
    queue = queue.then(task);
    return queue;
  };

  const sync = () => toggles.forEach(({ kind, id, button }) => {
    button.setAttribute('aria-pressed', state[kind].has(id));
  });

  const loadSession = async () => {
    session = await getSession();
    if (session?.authenticated) {
      [state.schedule, state.favorites] = await Promise.all([
        getIds('schedule', eventId),
        getIds('favorites', eventId),
      ]);
    } else {
      state.schedule.clear();
      state.favorites.clear();
    }
    sync();
  };

  const requireLogin = (action) => {
    pending = action;
    document.dispatchEvent(new CustomEvent('login:required'));
  };

  const perform = async ({ kind, id, add }) => {
    const message = messages.get(id);
    message.textContent = '';
    const query = `eventId=${encodeURIComponent(eventId)}&sessionId=${encodeURIComponent(id)}`;
    const headers = { 'x-csrf-token': session.csrfToken };
    if (add) { headers['content-type'] = 'application/json'; }
    let status = 0;
    try {
      const res = await fetch(add ? KINDS[kind].path : `${KINDS[kind].path}?${query}`, {
        method: add ? 'POST' : 'DELETE',
        mode: 'same-origin',
        headers,
        body: add ? JSON.stringify({ eventId, sessionId: id }) : undefined,
      });
      ({ status } = res);
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) {
      state[kind][add ? 'add' : 'delete'](id);
      sync();
    } else if (status === 401) {
      requireLogin({ kind, id, add });
    } else if (status === 403 && kind === 'schedule') {
      message.textContent = MESSAGES.register;
      requireLogin({ kind, id, add });
    } else {
      message.textContent = status === 409 && kind === 'schedule' ? MESSAGES.overlap : MESSAGES.error;
    }
  };

  const toggle = (kind, id) => {
    const action = { kind, id, add: !state[kind].has(id) };
    serial(async () => {
      if (state[kind].has(id) === action.add) { return; }
      if (session?.authenticated) {
        await perform(action);
      } else {
        requireLogin(action);
      }
    });
  };

  const item = (entry, i) => {
    const id = String(entry.id);
    const titleId = `${prefix}-title-${i}`;
    const title = tag('h4', { id: titleId, class: 'session-catalog-title' });
    if (entry.videoId) {
      const href = `${sessionPage}?session=${encodeURIComponent(id)}`;
      title.append(tag('a', { href, text: entry.title ?? id }));
    } else {
      title.textContent = entry.title ?? id;
    }
    const details = [when(entry.start, entry.end), entry.speaker && tag('p', { class: 'session-catalog-speaker', text: entry.speaker })]
      .filter(Boolean);
    const actions = tag('div', { class: 'session-catalog-actions' });
    for (const kind of Object.keys(KINDS)) {
      const button = tag('button', {
        type: 'button',
        class: `session-catalog-${kind}`,
        'aria-pressed': 'false',
        'aria-describedby': titleId,
        text: KINDS[kind].label,
      });
      button.addEventListener('click', () => toggle(kind, id));
      toggles.push({ kind, id, button });
      actions.append(button);
    }
    const message = tag('p', { class: 'session-catalog-message', 'aria-live': 'polite' });
    messages.set(id, message);
    return tag('li', { class: 'session-catalog-session' }, title, ...details, actions, message);
  };

  const render = (data) => {
    const tracks = new Map();
    data.filter((entry) => entry?.id != null && entry.id !== '').forEach((entry) => {
      const track = entry.track || 'Other';
      if (!tracks.has(track)) { tracks.set(track, []); }
      tracks.get(track).push(entry);
    });
    let i = 0;
    el.replaceChildren(...[...tracks].map(([track, entries]) => tag(
      'section',
      { class: 'session-catalog-track' },
      tag('h3', { text: track }),
      tag('ul', {}, ...entries.map((entry) => { i += 1; return item(entry, i); })),
    )));
  };

  const sameOrigin = source && new URL(source).origin === window.location.origin;
  const catalog = sameOrigin
    ? getJson(source, (d) => Array.isArray(d?.data))
    : Promise.resolve(null);
  el.replaceChildren();
  catalog.then((json) => {
    if (!json) {
      el.replaceChildren(tag('p', { class: 'session-catalog-unavailable', text: MESSAGES.unavailable }));
      return;
    }
    render(json.data);
    sync();
  });
  serial(loadSession);

  document.addEventListener('session:changed', (e) => {
    if (!el.isConnected) { return; }
    serial(async () => {
      await loadSession();
      if (!e.detail?.authenticated || !session?.authenticated || !pending) { return; }
      const action = pending;
      pending = null;
      if (state[action.kind].has(action.id) !== action.add) { await perform(action); }
    });
  });
}
