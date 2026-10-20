/*
 * event-details — fetches live event data from the App Builder action and
 * renders it. The page is static/cached; THIS is the dynamic island.
 *
 * Data flow:  DA sheet (authors)  →  get-event action (fetch + validate)  →  this block
 *
 * Authoring: the block's first cell holds an event ID that MUST exist as a row
 * in the DA events sheet, e.g.
 *   | event-details |
 *   | houston-2026  |
 */

// Cached CDN host (adobeio-STATIC) — fast, honours the action's Cache-Control.
// Use adobeioruntime.net only when debugging (always executes, always logs).
import { getConfig } from '../../scripts/ak.js';

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
  } catch { return iso; }
}

function render(el, data) {
  const statusClass = data.status.toLowerCase().replace(/\s+/g, '-');
  el.innerHTML = `
    <div class="event-card">
      <div class="event-head">
        <h3>${data.name}</h3>
        <span class="event-status status-${statusClass}">${data.status}</span>
      </div>
      <p class="event-when">${fmtDate(data.startsAt)}</p>
      <p class="event-where">${data.venue}${data.address ? ` · ${data.address}` : ''}</p>
      <p class="event-weather">${data.weather.icon} ${data.weather.tempF}°F, ${data.weather.summary} at the venue</p>

      <div class="event-seats"><strong>${data.seatsRemaining}</strong> seats remaining</div>

      <div class="event-presenter">
        ${data.presenter.photo ? `<img src="${data.presenter.photo}" alt="${data.presenter.name}" loading="lazy">` : ''}
        <div>
          <p class="presenter-name">${data.presenter.name}</p>
          <p class="presenter-title">${data.presenter.title}</p>
        </div>
      </div>

      <p class="event-session">${data.track}${data.room ? ` · ${data.room}` : ''}</p>
    </div>`;
}

export default async function init(el) {
  const { eventActionUrl } = getConfig();
  // 1) Read the authored event ID (must match a sheet row id), then clear.
  // Authoring is a key/value row:  | id | <event-id> |
  // Read the LAST NON-EMPTY cell's text (the value), so a trailing empty cell is ignored.
  const cells = [...el.querySelectorAll(':scope > div > div')]
    .map((c) => c.textContent.replace(/\s+/g, '').trim())
    .filter(Boolean);
  const eventId = cells[cells.length - 1] || 'houston-2026';

  el.textContent = '';

  // 2) Loading state — never show an empty box.
  el.innerHTML = '<p class="event-loading">Loading event details…</p>';

  // 3) Fetch from the action.
  try {
    const res = await fetch(`${eventActionUrl}?eventId=${encodeURIComponent(eventId)}`);
    if (!res.ok) throw new Error(`Action returned ${res.status}`); // e.g. 404 = id not in sheet / row invalid
    const data = await res.json();
    render(el, data);
  } catch (err) {
    // 4) Graceful fallback — never a broken page.
    el.innerHTML = '<p class="event-error">Event details are unavailable right now. Please check back shortly.</p>';
  }
}
