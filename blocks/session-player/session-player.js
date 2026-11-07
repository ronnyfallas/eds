import { getMetadata } from '../../scripts/ak.js';

const STATES = {
  401: { text: 'Login to view this video', button: 'Login' },
  403: { text: 'Register for this event to watch', button: 'Complete registration' },
  404: { text: 'No video for this session' },
  error: { text: 'This video is unavailable right now.' },
};

function tag(name, attrs = {}, text = '') {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attrs)) { node.setAttribute(key, value); }
  node.textContent = text;
  return node;
}

async function getToken(eventId, sessionId) {
  const query = `eventId=${encodeURIComponent(eventId)}&sessionId=${encodeURIComponent(sessionId)}`;
  try {
    const res = await fetch(`/api/media-token?${query}`, { mode: 'same-origin', cache: 'no-store' });
    if (res.status !== 200) { return { status: res.status }; }
    const { url } = await res.json();
    return typeof url === 'string' && url ? { status: 200, url } : { status: 0 };
  } catch {
    return { status: 0 };
  }
}

export default function init(el) {
  const sessionId = el.querySelector(':scope > div > div')?.textContent.trim()
    || new URLSearchParams(window.location.search).get('session');
  const eventId = getMetadata('event-id') ?? '';

  const frame = tag('div', { class: 'session-player-frame' });
  const status = tag('p', { class: 'session-player-status', 'aria-live': 'polite' });
  let video = null;
  let current = null;
  let retried = false;
  let seq = 0;

  const announce = (state, text) => {
    if (current !== null && state !== current) { status.textContent = text; }
    current = state;
  };

  const lock = (code) => {
    const state = STATES[code] ?? STATES.error;
    const focused = frame.contains(document.activeElement);
    if (video) {
      video.removeAttribute('src');
      video.load();
      video = null;
    }
    const children = [tag('p', { class: 'session-player-message' }, state.text)];
    if (state.button) {
      const button = tag('button', { type: 'button', class: 'session-player-button' }, state.button);
      button.addEventListener('click', () => document.dispatchEvent(new CustomEvent('login:required')));
      children.push(button);
    }
    frame.replaceChildren(...children);
    if (focused) { frame.querySelector('button')?.focus(); }
    announce(String(code in STATES ? code : 'error'), state.text);
  };

  const setSource = (url, at = 0, playing = false) => {
    video.src = url;
    if (at) { video.currentTime = at; }
    if (playing) { video.play().catch(() => {}); }
  };

  const request = async () => {
    seq += 1;
    const mine = seq;
    const result = await getToken(eventId, sessionId);
    return mine === seq ? result : null;
  };

  const recover = async () => {
    if (retried) {
      lock(401);
      return;
    }
    retried = true;
    const at = video.currentTime;
    const playing = !video.paused;
    const result = await request();
    if (!result) { return; }
    if (result.status === 200) {
      setSource(result.url, at, playing);
    } else {
      lock(401);
    }
  };

  const unlock = (url) => {
    if (video) {
      setSource(url, video.currentTime, !video.paused);
      return;
    }
    const focused = frame.contains(document.activeElement);
    video = tag('video', { controls: '', playsinline: '', preload: 'metadata', 'aria-label': 'Session video' });
    video.addEventListener('error', (e) => {
      if (e.target === video) { recover(); }
    });
    video.addEventListener('loadeddata', () => { retried = false; });
    setSource(url);
    frame.replaceChildren(video);
    if (focused) { video.focus(); }
    announce('200', 'Video unlocked');
  };

  const refresh = async () => {
    const result = await request();
    if (!result) { return; }
    if (result.status === 200) {
      unlock(result.url);
    } else {
      lock(result.status);
    }
  };

  lock(sessionId ? 401 : 404);
  el.replaceChildren(frame, status);
  if (!sessionId) { return; }
  document.addEventListener('session:changed', () => {
    if (el.isConnected) { refresh(); }
  });
  refresh();
}
