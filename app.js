// Yorker dashboard — vanilla JS, hash-routed SPA.
// Reads three JSON files written by scrape.py and a per-match file on demand.

"use strict";

const TEAM_ID = 11361;
const TEAM_DISPLAY = "Blazing Firebirds";

// Where data JSON lives. On the web (GitHub Pages) the data sits beside the
// app, so relative paths resolve correctly and DATA_BASE stays "". Inside the
// native app (Capacitor wrapper) the shell is bundled locally and served from
// capacitor://localhost, so data must be fetched from the live Pages origin
// instead. Detection is a no-op on the website (window.Capacitor is undefined).
const IS_NATIVE_APP =
  (typeof window !== "undefined" &&
    window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === "function" &&
    window.Capacitor.isNativePlatform()) ||
  (typeof location !== "undefined" && location.protocol === "capacitor:");
const DATA_BASE = IS_NATIVE_APP
  ? "https://yorker.app/"
  : "";
const dataUrl = (path) => DATA_BASE + path;

// Web Push config. WEBHOOK_URL is the same Apps Script endpoint that handles
// calendar events; it routes by the `action` field in the JSON payload.
// Set WEBHOOK_URL to the script.google.com /exec URL once deployed — until
// then the notification toggle is disabled gracefully.
const VAPID_PUBLIC_KEY = "BNsboyZ5ByFkhQ5h_NLXmIMqbBVTEzzZQ3tBfFw5HkvydoXMswNxAsJ4MrYqhUSAbc4ujyW2WgxXiEMpe5bd7hs";
const WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbyHf7RsP-jZZdI4eOqV3Bw-Egk85mULHw4Kr_32xzH3wLiF6gC1A-yQGl93QcdZPpk10Q/exec";

// Squad jersey numbers, keyed by canonical first-name key (after aliases are
// applied — see PLAYER_ALIASES). Any player not in this map is treated as a
// stand-in and shown with their initials instead of a number.
const ROSTER = {
  vernon: 43,
  jacob: 8,
  jack: 46,
  anvaya: 13,
  owen: 3,
  ria: 67,
  will: 10,
  liam: 12,
};

// The eight core squad keys + surnames. Used by coreKey (misspelling match)
// and playerKey (surname gate). Mirror of scrape.py's ROSTER_KEYS / ROSTER_SURNAMES.
const ROSTER_KEYS = new Set(Object.keys(ROSTER));
const ROSTER_SURNAMES = {
  vernon: "stewart", jacob: "brown", jack: "butler", anvaya: "metikurke",
  owen: "buchan", ria: "sathish kumar", will: "eltringham", liam: "laing",
};

// Misspelling aliases. If a Spawtz scorer types the name differently
// across matches, fold their variant to the canonical key so stats merge
// onto one record. Add a line here per misspelling.
// Mirror this map in scrape.py (PLAYER_ALIASES) for the aggregator.
const PLAYER_ALIASES = {
  anuya: "anvaya",
};

// Display-name overrides — the canonical full name to show for a player,
// keyed by canonical key (post-alias). Auto-built for the eight core squad
// members from ROSTER_SURNAMES, so a core player ALWAYS shows their real full
// name on the dashboard even when a single scorecard arrives surname-less (a
// parent gave the umpire first names only, so Spawtz filled the surname with
// its "Unknown" placeholder) or with a misspelled surname. Add hand exceptions
// to the trailing block; they win over the auto-built names.
const NAME_OVERRIDES = {
  ...Object.fromEntries(
    Object.entries(ROSTER_SURNAMES).map(([first, surname]) => [
      first,
      [first, ...surname.split(" ")]
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" "),
    ]),
  ),
  // Manual exceptions go here (override the auto-built core names if needed).
};

// Stand-in full names — auto-built from the schedule sheet (data/schedule.json),
// which is the source of truth for a stand-in's surname. The Spawtz scoresheet
// usually records a stand-in by first name only (+ an "Unknown" placeholder
// surname), so once a game is played players.json loses the surname. This map
// lets displayName() restore it everywhere the full name should show. Keyed by
// first-name key -> full sheet name; rebuilt by refreshStandinNames() on load.
let STANDIN_NAMES = {};

// Parents — first names only. Shown on each player's detail page.
// Sourced from the team WhatsApp; add or correct as we learn more.
const PARENTS = {
  anvaya: ["Mahima"],
  jack: ["Matt (coach)", "Lisa"],
  jacob: ["Adam", "Joanna"],
  liam: ["Richard", "Moira"],
  owen: ["Erin", "Matt"],
  ria: ["Anoja"],
  vernon: ["Brandon", "Alex"],
  will: ["Nicky", "Wayne"],
};

function parentsFor(name) {
  return PARENTS[playerKey(name)] ?? [];
}

function formatList(items) {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} & ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} & ${items[items.length - 1]}`;
}

function jerseyNumber(name) {
  const key = playerKey(name);
  return Object.prototype.hasOwnProperty.call(ROSTER, key) ? ROSTER[key] : null;
}

function displayName(name, { opponent = false } = {}) {
  // Strip the scorer's "Unknown" placeholder surname; keep the rest verbatim.
  const stripped = (name ?? "")
    .split(/\s+/)
    .filter(token => token && token.toLowerCase() !== "unknown")
    .join(" ");
  // Opposition players are shown exactly as Spawtz recorded them — never folded
  // onto our roster (their Liam is not our Liam) and never given one of our
  // stand-ins' full names. A placeholder "Unknown" surname is dropped, so only
  // their first name shows; a real opposition surname is shown as-is.
  if (opponent) return stripped;

  const key = playerKey(name);
  const resolved = NAME_OVERRIDES[key] ?? stripped;
  // A stand-in's full name lives only in the schedule sheet (the source of
  // truth); the scoresheet usually has just their first name. If this is a
  // surname-less stand-in (not a core player) and the sheet knows their full
  // name, show that. The Stand-ins lineup box uses firstNameOnly() instead, so
  // it stays first-name-only by design.
  if (resolved && !resolved.includes(" ")) {
    const fk = firstNameKey(resolved);
    if (!ROSTER_KEYS.has(fk)) {
      const full = standinFullName(fk);
      if (full) return full;
    }
  }
  return resolved;
}

// Rebuild STANDIN_NAMES from the loaded schedule. A stand_ins entry is only
// useful here if it carries a surname (more than one token) and isn't a core
// player's first name (we never shadow a core squad member).
function refreshStandinNames() {
  const map = {};
  const games = state.schedule?.games || {};
  for (const iso in games) {
    for (const raw of (games[iso].stand_ins || [])) {
      const full = (raw || "").trim();
      if (!full || !full.includes(" ")) continue;
      const fk = firstNameKey(full);
      if (!fk || ROSTER_KEYS.has(fk)) continue;
      map[fk] = full;
    }
  }
  STANDIN_NAMES = map;
}

// Resolve a stand-in's full sheet name from their first-name key. Exact match
// wins; failing that, a one-letter difference is accepted as a scorer's
// misspelling of the SAME stand-in (sheet "Conor" vs scoresheet "Connor"), so
// the sheet's full name still restores instead of the dashboard falling back to
// the misspelled bare first name. The fuzzy step is deliberately tight (edit
// distance 1) so two genuinely different stand-ins are never merged.
function standinFullName(fk) {
  if (!fk) return null;
  if (STANDIN_NAMES[fk]) return STANDIN_NAMES[fk];
  for (const k in STANDIN_NAMES) {
    if (levenshtein(k, fk) <= 1) return STANDIN_NAMES[k];
  }
  return null;
}

const state = {
  team: null,
  fixtures: null,
  players: null,
  schedule: null,
  standings: null,
  divisionTeams: new Map(),
  matchCache: new Map(),
  resultsVisible: 3,
  resultsFilter: "played", // "played" | "won" | "lost"
  // Per-team-page results filter/pagination (mirrors the home ones). Reset
  // when navigating to a different team (teamFilterFor tracks which team they apply to).
  teamVisible: 3,
  teamFilter: "played",
  teamFilterFor: null,
};

// --- localStorage cache --------------------------------------------
// We mirror team/fixtures/players JSON into localStorage so the next
// cold load can paint last-known data synchronously, before the
// network fetch resolves. The notify chip's last definitive state is
// cached too, so it doesn't flicker through "off → on" on every load
// for users who have notifications enabled.
const CACHE_KEYS = {
  team: "firebirds.cache.team",
  fixtures: "firebirds.cache.fixtures",
  players: "firebirds.cache.players",
  schedule: "firebirds.cache.schedule",
  standings: "firebirds.cache.standings",
  notifyState: "firebirds.notify_state",
};

function readCachedJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCachedJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// --- Analytics (GA4) --------------------------------------------------
// gtag.js loads from index.html with automatic page_view disabled; render()
// sends a virtual page_view per hash route instead, so GA sees one clean
// screen path per view. trackEvent is safe to call anywhere: gtag is stubbed
// in index.html (calls queue in dataLayer even before/without the script),
// and anything thrown by an ad-blocker shim is swallowed — analytics must
// never break the app.

// How the app is being run — every GA report can segment installed-app users
// from browser visitors via the app_mode user property set below.
const APP_MODE = IS_NATIVE_APP
  ? "native_app"
  : (window.matchMedia("(display-mode: standalone)").matches ||
     window.navigator.standalone === true)
    ? "pwa"
    : "browser";

// Per-device analytics opt-out — excludes ONE device (Brandon's own iPhone
// PWA) from GA without touching anyone else who installs the app. The flag
// lives in this device's localStorage, so it's scoped to exactly this
// install. Toggle it with a URL hook: `?ga=off` opts this device out, `?ga=on`
// opts it back in. Because the installed iOS PWA has no address bar to type
// the param, a long-press on the Leaderboard wordmark toggles the same flag
// in place (see wireAnalyticsOptOut). The choice persists across launches.
const GA_OPTOUT_KEY = "firebirds.ga_optout";

function gaOptedOut() {
  try { return localStorage.getItem(GA_OPTOUT_KEY) === "1"; } catch { return false; }
}

function setGaOptOut(off) {
  try {
    if (off) localStorage.setItem(GA_OPTOUT_KEY, "1");
    else localStorage.removeItem(GA_OPTOUT_KEY);
  } catch {}
}

// Honour an explicit `?ga=on|off` hook at startup (works in any browser
// context, and rides in via the PWA start_url too). Returns the live state.
(function applyGaParam() {
  try {
    const v = new URLSearchParams(window.location.search).get("ga");
    if (v === "off") setGaOptOut(true);
    else if (v === "on") setGaOptOut(false);
  } catch {}
})();

let GA_EXCLUDED = gaOptedOut();

function trackEvent(name, params) {
  if (GA_EXCLUDED) return;
  try {
    if (typeof gtag === "function") gtag("event", name, params || {});
  } catch {}
}

try {
  if (!GA_EXCLUDED && typeof gtag === "function") {
    gtag("set", "user_properties", { app_mode: APP_MODE });
  }
} catch {}

// One virtual page_view per route change. render() re-runs on every data
// refresh / live repaint / hero flip, so consecutive repaints of the same
// route are deduped here — only real navigation is counted.
let lastTrackedRoute = null;

function pageTitleFor(path) {
  if (!path) return "Home";
  if (path === "standings") return "Leaderboard";
  if (path.startsWith("player/")) return `Player — ${decodeURIComponent(path.slice("player/".length))}`;
  if (path.startsWith("match/")) return "Match scorecard";
  if (path.startsWith("upcoming/")) return "Upcoming game";
  if (path.startsWith("team/")) {
    const parts = path.split("/");
    const name = divTeamName(parseInt(parts[1], 10));   // "Team" until resolvable
    if (parts[2] === "player") return `${name} — player`;
    if (parts[2] === "upcoming") return `${name} — upcoming game`;
    return name;
  }
  return path;
}

function gaSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Slugified team name for GA paths ("Anderson Aces" → "anderson-aces");
// null until the name is resolvable (standings or the team's own JSON).
function teamNameSlug(teamId) {
  const name = state.standings?.teams?.find(x => x.team_id === teamId)?.name
    || state.divisionTeams.get(teamId)?.team?.name;
  return (name && gaSlug(name)) || null;
}

// Human-readable GA identity for a fixture page: path slug
// "blazing-firebirds-vs-renegades-2026-05-16" + matching title
// "Blazing Firebirds vs Renegades — 16 May 2026". Teams meet more than once
// a season, so the date keeps each meeting its own GA row. kind picks the
// path prefix: "match", "upcoming", or "team-upcoming" (which nests under
// /team/{name}/upcoming using teamId). Returns null when the team names
// aren't resolvable — the caller's trackPageView then falls back to the
// raw /match/{fid} route.
function gaFixtureOverride(fixture, kind, teamId) {
  const h = fixture?.home?.display, a = fixture?.away?.display;
  if (!h || !a) return null;
  const dt = parseSpawtzDate(fixture.date_str, fixture.time);
  const iso = dt
    ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`
    : "";
  const slug = `${gaSlug(h)}-vs-${gaSlug(a)}${iso ? `-${iso}` : ""}`;
  const title = `${h} vs ${a}` + (dt
    ? ` — ${dt.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" })}`
    : "");
  const prefix = kind === "team-upcoming"
    ? `/team/${teamNameSlug(teamId) ?? teamId}/upcoming`
    : `/${kind}`;
  return { path: `${prefix}/${slug}`, title };
}

// The path GA reports: the route as-is, except team routes swap the opaque
// Spawtz team id for the team-name slug (/team/anderson-aces) so GA reports
// are readable at a glance. The id stays only if the name can't be resolved
// (offline cold hit on a direct link). The app's real URLs are untouched.
function gaPagePath(path) {
  if (path.startsWith("team/")) {
    const parts = path.split("/");
    const slug = teamNameSlug(parseInt(parts[1], 10));
    if (slug) parts[1] = slug;
    return `/${parts.join("/")}`;
  }
  return `/${path || "home"}`;
}

function trackPageView(path, override) {
  const route = path || "home";
  if (route === lastTrackedRoute) return;
  lastTrackedRoute = route;
  trackEvent("page_view", {
    page_path: override?.path || gaPagePath(path),
    page_title: override?.title || pageTitleFor(path),
    page_location: window.location.href,
  });
}

document.addEventListener("DOMContentLoaded", init);
// Wrap render so the HashChangeEvent isn't passed as `skipScroll` — every hash
// navigation must scroll to the top of the new page (e.g. a player's name/header
// sits above the fold when tapped from a scrolled-down squad on mobile).
window.addEventListener("hashchange", () => render());

// --- Tooltips --------------------------------------------------------
// On-brand tooltip for any [data-tip] element. One reused fixed-position node,
// so it escapes the table-card's overflow:hidden and never clips; positioned
// just ABOVE the target (so a tapping finger on mobile doesn't cover it),
// clamped to the viewport, arrow tracking the target's centre. Triggered by
// hover and keyboard focus.
(() => {
  let tip = null;
  function show(el) {
    const text = el.getAttribute("data-tip");
    if (!text) return;
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "fb-tip";
      tip.setAttribute("role", "tooltip");
      document.body.appendChild(tip);
    }
    tip.textContent = text;
    tip.classList.add("is-visible");
    const r = el.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(
      r.left + r.width / 2 - tip.offsetWidth / 2,
      window.innerWidth - tip.offsetWidth - pad
    ));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(Math.max(pad, r.top - tip.offsetHeight - 9))}px`;
    tip.style.setProperty("--tip-arrow", `${Math.round(r.left + r.width / 2 - left)}px`);
  }
  function hide() { if (tip) tip.classList.remove("is-visible"); }
  const closestTip = (e) => e.target && e.target.closest && e.target.closest("[data-tip]");
  document.addEventListener("pointerover", (e) => { const el = closestTip(e); if (el) show(el); });
  document.addEventListener("pointerout", (e) => { const el = closestTip(e); if (el && !el.contains(e.relatedTarget)) hide(); });
  document.addEventListener("focusin", (e) => { const el = closestTip(e); if (el) show(el); });
  document.addEventListener("focusout", hide);
  window.addEventListener("scroll", hide, true);
})();

// --- PWA install ----------------------------------------------------
//
// Two paths, picked by platform:
//   - Android / desktop Chrome+Edge: capture `beforeinstallprompt`, swap
//     it into a custom chip the user can tap → OS install dialog.
//   - iOS (any browser — all are WebKit and have no install API): show
//     the chip immediately; tapping opens an overlay telling them to use
//     Share → Add to Home Screen.
// The chip stays hidden when the app is already running standalone (so
// the installed PWA never sees it) — and inside the native app wrapper,
// where "Add to Home Screen" is meaningless (it's already an installed app).
const isStandalonePWA = APP_MODE !== "browser";
const isIOSDevice =
  /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
// Share-button location on iOS: Safari is the only mainstream iOS browser
// that puts its share button in the bottom toolbar. Chrome / Firefox /
// Edge on iOS all keep it up near the address bar. Default to "top" and
// only flip to "bottom" if we positively detect Safari (no CriOS / FxiOS
// / EdgiOS in the UA).
const isIOSSafari =
  isIOSDevice && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
const iosShareLocation = isIOSSafari ? "bottom" : "top";
let deferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  // Stop Chrome's default mini-infobar so we control the moment of asking.
  e.preventDefault();
  deferredInstallPrompt = e;
  document.querySelectorAll(".install-chip").forEach((el) => {
    el.hidden = false;
  });
});

window.addEventListener("appinstalled", () => {
  trackEvent("app_installed");
  deferredInstallPrompt = null;
  document.querySelectorAll(".install-chip").forEach((el) => {
    el.hidden = true;
  });
});

// Refresh when the page is restored from bfcache (Safari/Chrome often
// serve a browser refresh from memory without re-running JS) or when the
// tab regains focus. Throttled so rapid tab-switching doesn't hammer the
// network.
let lastFetchAt = 0;
window.addEventListener("pageshow", (e) => {
  if (e.persisted) refresh();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refresh();
    recordActivation();
  }
});

// Keep the meta strip's "• offline" tag in sync with the actual connection
// state, and auto-refresh when the user comes back online so they pick up
// anything that landed while they were disconnected.
window.addEventListener("offline", () => updateMetaStrip());
window.addEventListener("online", () => {
  updateMetaStrip();
  // Bypass the 30s throttle — we want fresh data right when the connection
  // returns, not 30s later.
  lastFetchAt = 0;
  refresh();
});

async function init() {
  // Wire the header share button once — it reads the current route at click
  // time, so it always shares whatever page the user is on.
  wireShareButton();
  wireAnalyticsOptOut();
  wireExternalLinksForIosPwa();

  // Paint last-known data from localStorage immediately so the dashboard
  // doesn't sit on a "loading" placeholder while the network resolves.
  // The fresh fetch follows and overwrites the view within a moment.
  const cachedTeam = readCachedJson(CACHE_KEYS.team);
  const cachedFixtures = readCachedJson(CACHE_KEYS.fixtures);
  const cachedPlayers = readCachedJson(CACHE_KEYS.players);
  const cachedSchedule = readCachedJson(CACHE_KEYS.schedule);
  const cachedStandings = readCachedJson(CACHE_KEYS.standings);
  if (cachedTeam && cachedFixtures && cachedPlayers) {
    state.team = cachedTeam;
    state.fixtures = cachedFixtures;
    state.players = cachedPlayers;
    state.schedule = cachedSchedule || null;
    state.standings = cachedStandings || null;
    refreshStandinNames();
    updateMetaStrip();
    render();
  }
  try {
    await loadData();
  } catch (err) {
    if (!state.team) {
      const msg = navigator.onLine
        ? `Couldn't load data. ${escapeHtml(err.message)}`
        : "Currently offline — Please check your connection";
      document.getElementById("app").innerHTML =
        `<div class="loading">${msg}</div>`;
    }
    console.error(err);
  }
  // Fire-and-forget — registers the visit in the Activations sheet so
  // Brandon can see how many devices are using the dashboard. Throttled
  // by recordActivation so opening the same tab repeatedly doesn't spam
  // the log.
  recordActivation();

  // Live-score poll. It self-gates: zero network outside the game window /
  // offline / when the tab is hidden, so it's safe to run unconditionally.
  setInterval(pollLiveScore, LIVE_POLL_MS);
}

async function refresh(skipScroll) {
  if (Date.now() - lastFetchAt < 30_000) return;
  try {
    await loadData(skipScroll);
  } catch (err) {
    // Keep the current view on a transient failure; just log.
    console.error("Refresh failed:", err);
  }
}

// Refresh now, ignoring the 30s throttle — for the live-score poll, where the
// whole point is "give me the latest right now".
function forceRefresh(skipScroll) {
  lastFetchAt = 0;
  return refresh(skipScroll);
}

async function loadData(skipScroll) {
  const [team, fixtures, players, schedule, standings] = await Promise.all([
    fetchJson("data/team.json"),
    fetchJson("data/fixtures.json"),
    fetchJson("data/players.json"),
    fetchJson("data/schedule.json").catch(() => null),
    fetchJson("data/standings.json").catch(() => null),
  ]);
  state.team = team;
  state.fixtures = fixtures;
  state.players = players;
  state.schedule = schedule;
  state.standings = standings;
  refreshStandinNames();
  writeCachedJson(CACHE_KEYS.team, team);
  writeCachedJson(CACHE_KEYS.fixtures, fixtures);
  writeCachedJson(CACHE_KEYS.players, players);
  if (schedule) writeCachedJson(CACHE_KEYS.schedule, schedule);
  if (standings) writeCachedJson(CACHE_KEYS.standings, standings);
  lastFetchAt = Date.now();
  updateMetaStrip();
  render(skipScroll);
}

async function fetchJson(path) {
  const r = await fetch(dataUrl(path), { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function updateMetaStrip() {
  const meta = document.getElementById("meta-strip");
  if (!meta || !state.team) return;
  if (!navigator.onLine) {
    // When offline, surface the connection state in a pill and drop the
    // "updated X ago" text — the timestamp is no longer the useful signal.
    meta.innerHTML = `
      <span class="meta-pill meta-pill--offline">
        <svg class="meta-pill__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M1 1l22 22"/>
          <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
          <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
          <path d="M10.71 5.05A16 16 0 0 1 22.58 9"/>
          <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
          <line x1="12" y1="20" x2="12.01" y2="20"/>
        </svg>
        Offline
      </span>`;
    meta.removeAttribute("title");
    return;
  }
  const dt = new Date(state.team.generated_at_nz);
  meta.textContent = `Updated ${relativeTime(dt)}`;
  meta.title = dt.toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short" });
}

function wireShareButton() {
  const btn = document.getElementById("share-btn");
  if (btn) btn.addEventListener("click", shareCurrentPage);
}

// Hidden per-device analytics toggle. A ~1.2s long-press on the header
// wordmark flips this device's GA opt-out — the only way to reach it inside
// the installed iOS PWA, which has no address bar for the `?ga=off` hook. It
// suppresses the press's normal "go home" navigation, toggles the flag, and
// flashes a one-line confirmation. Deliberately undiscoverable: a normal tap
// still just goes home. Gated to the LEADERBOARD wordmark only: the banner is
// contextual (our name on our views, another team's on theirs, "Leaderboard /
// Division N" on the ladder), and the toggle arms only while it reads
// "Leaderboard …" — i.e. when the user is on the standings page.
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
function brandIsLeaderboard() {
  const host = document.getElementById("brand-text");
  return !!host && norm(host.textContent).startsWith("leaderboard");
}

function wireAnalyticsOptOut() {
  const brand = document.querySelector("a.brand");
  if (!brand) return;
  let timer = null, fired = false;
  const start = () => {
    fired = false;
    if (!brandIsLeaderboard()) return;   // only on the Leaderboard wordmark
    timer = setTimeout(() => {
      fired = true;
      const off = !gaOptedOut();
      setGaOptOut(off);
      GA_EXCLUDED = off;
      if (!off && typeof gtag === "function") {
        try { gtag("set", "user_properties", { app_mode: APP_MODE }); } catch {}
      }
      showAnalyticsToast(off
        ? "This device is now excluded from analytics"
        : "This device is now included in analytics");
    }, 1200);
  };
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  brand.addEventListener("touchstart", start, { passive: true });
  brand.addEventListener("mousedown", start);
  ["touchend", "touchmove", "touchcancel", "mouseup", "mouseleave"].forEach((ev) =>
    brand.addEventListener(ev, cancel));
  // Swallow the click that follows a long-press so it doesn't navigate home.
  brand.addEventListener("click", (e) => {
    if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; }
  });
  // Belt-and-suspenders for the iOS long-press: on the link pages the wordmark
  // is an <a>, and iOS lifts a link onto a white drag "platter" / shows a
  // callout on press-and-hold. The CSS (user-drag/touch-callout none) handles
  // it, but block the drag + context menu here too so it can't surface.
  brand.addEventListener("dragstart", (e) => e.preventDefault());
  brand.addEventListener("contextmenu", (e) => e.preventDefault());
}

function showAnalyticsToast(text) {
  let el = document.getElementById("ga-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "ga-toast";
    el.style.cssText =
      "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);" +
      "z-index:9999;max-width:88%;padding:10px 16px;border-radius:999px;" +
      "background:#134f5c;color:#fff;font-size:13px;text-align:center;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.25);opacity:0;transition:opacity .2s;";
    document.body.appendChild(el);
  }
  el.textContent = text;
  requestAnimationFrame(() => { el.style.opacity = "1"; });
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = "0"; }, 2600);
}

// Installed iOS home-screen app ONLY: external links (e.g. the footer's "Hutt
// Indoor Sports") normally open in iOS's in-app Safari overlay. Rewrite them to
// the (undocumented) x-safari- scheme so iOS opens them in the full Safari app —
// a genuinely separate window. Gated on navigator.standalone, which is true only
// in an iOS standalone PWA, so the website, Android and desktop are untouched.
function wireExternalLinksForIosPwa() {
  if (navigator.standalone !== true) return;
  document.querySelectorAll('a[target="_blank"][href^="http"]').forEach((a) => {
    a.setAttribute("href", "x-safari-" + a.getAttribute("href"));
    a.removeAttribute("target");   // the scheme itself does the break-out
  });
}

// The title that travels with a shared link — the *key title* of the page the
// user is on, so the share sheet (and any app that shows the share text) reads
// for that specific page: the player's name on a player page, "Team A vs Team B"
// on a match, "Leaderboard — Division 8" on the ladder, otherwise the team /
// app name. (The rich preview card's image + title come from the static OG tags
// in index.html — those are one fixed card for every link, because link
// crawlers ignore the #hash and don't run this JS.)
function shareTitleFor(path, from) {
  if (path === "standings") {
    return `Leaderboard — ${state.standings?.division_name || "Division"}`;
  }
  // Most detail pages already render their key title in .detail-header__name
  // (player name; "Team A vs Team B"). Reuse it, minus any result badge.
  const h = document.querySelector("#app .detail-header__name");
  if (h) {
    const clone = h.cloneNode(true);
    clone.querySelectorAll(".badge").forEach((b) => b.remove());
    const t = clone.textContent.replace(/\s+/g, " ").trim();
    if (t) return t;
  }
  // Home / team landing have no detail header — use the banner name.
  return brandTarget(path, from).name || TEAM_DISPLAY;
}

// Share the page the user is currently on. The title/text is that page's key
// title (see shareTitleFor); the URL is the full deep link (hash route included)
// so it opens straight to that page. Uses the native share sheet where
// available, else copies the link to the clipboard, else falls back to a prompt.
async function shareCurrentPage() {
  const { path, from } = parseHash();
  const name = shareTitleFor(path, from);
  const url = window.location.href;
  // GA's recommended "share" event; item_id is the route so reports show
  // WHICH pages people share. Tracked only after a share actually happens
  // (a dismissed share sheet doesn't count).
  const shared = (method) =>
    trackEvent("share", { method, content_type: "page", item_id: `/${path || "home"}` });
  if (navigator.share) {
    try { await navigator.share({ title: name, text: name, url }); shared("native"); }
    catch (_) { /* user dismissed the share sheet — not an error */ }
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(url); flashShareToast("Link copied"); shared("clipboard"); return; }
    catch (_) { /* fall through to prompt */ }
  }
  window.prompt("Copy this link to share:", url);
  shared("prompt");
}

function flashShareToast(msg) {
  let t = document.getElementById("share-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "share-toast";
    t.className = "share-toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  void t.offsetWidth;               // reflow so a repeat tap re-runs the transition
  t.classList.add("share-toast--show");
  clearTimeout(flashShareToast._t);
  flashShareToast._t = setTimeout(() => t.classList.remove("share-toast--show"), 1800);
}

function parseHash() {
  const raw = window.location.hash.slice(1);
  const [path, query] = raw.split("?");
  const params = new URLSearchParams(query || "");
  return { path: path || "", from: params.get("from") || "" };
}

function makeHash(path, from) {
  return from ? `${path}?from=${encodeURIComponent(from)}` : path;
}

function backTargetFor(from, fallbackHash, fallbackLabel) {
  // Given a `from` value (e.g. "player/vernon"), return the {hash, label}
  // for the back link. Falls back to the supplied defaults if `from` is empty
  // or doesn't resolve.
  if (!from) return { hash: fallbackHash, label: fallbackLabel };
  if (from.startsWith("player/")) {
    const key = decodeURIComponent(from.slice("player/".length));
    let player = state.players?.players.find(p => playerKey(p.name) === key);
    if (!player) player = state.players?.players.find(p => firstNameKey(p.name) === firstNameKey(key));
    const firstName = player
      ? displayName(player.name).split(/\s+/)[0]
      : key.charAt(0).toUpperCase() + key.slice(1);
    return { hash: from, label: `Back to ${firstName}` };
  }
  if (from.startsWith("match/")) {
    return { hash: from, label: "Back to Match" };
  }
  if (from.startsWith("upcoming/")) {
    return { hash: from, label: "Back to Game" };
  }
  if (from.startsWith("team/")) {
    const parts = from.split("/");
    if (parts[2] === "player") {
      return { hash: from, label: "Back to player" };
    }
    return { hash: from, label: `Back to ${divTeamName(parseInt(parts[1], 10))}` };
  }
  return { hash: fallbackHash, label: fallbackLabel };
}

// --- Live hero flip --------------------------------------------------
// When the hero / upcoming view is open, flip NEXT → LIVE → PLAYED the instant
// the game crosses each boundary by re-rendering the current view in place
// (no scroll-to-top), so it updates live without a reload.
let heroFlipTimer = null;

function scheduleHeroFlip(dt) {
  clearTimeout(heroFlipTimer);
  heroFlipTimer = null;
  if (!dt) return;
  const now = Date.now();
  const start = dt.getTime();
  const dur = gameDurationMs();
  const boundary = now < start ? start : (now < start + dur ? start + dur : null);
  if (boundary == null) return;             // game over — no further flips
  const delay = boundary - now;
  if (delay > 24 * 60 * 60 * 1000) return;  // too far off to hold a timer
  heroFlipTimer = setTimeout(() => render(true), delay + 400);  // re-render in place at the boundary
}

// --- Live score polling ------------------------------------------------
// The static data files are the dashboard's only score source, and nothing
// re-fetches them while a parent simply watches the game (the hero-flip timer
// only re-renders already-loaded data at phase boundaries). So during the game
// window we poll a tiny data/live.json (well under 1 KB) every LIVE_POLL_MS
// while the tab is visible and online; when its `rev` changes — a new scrape
// landed with changed scores — we re-fetch the full data and repaint in place.
// Outside the window, or offline/hidden, the poll does no network at all.
const LIVE_POLL_MS = 25_000;
let lastLiveRev = null;

// The hero game's start datetime IF we're currently inside the live-polling
// window: kickoff → +90 min (the one-hour game plus Spawtz's scoresheet lag).
function liveWindowGameDt() {
  const g = currentHeroGame();
  if (!g) return null;
  const dt = parseSpawtzDate(g.date_str, g.time);
  if (!dt) return null;
  const now = Date.now();
  const start = dt.getTime();
  const until = start + gameDurationMs() + 30 * 60 * 1000;
  return (now >= start && now < until) ? dt : null;
}

async function pollLiveScore() {
  if (!navigator.onLine || document.visibilityState !== "visible") return;
  if (!liveWindowGameDt()) return;            // only fetch during the live window
  let live;
  try {
    live = await fetchJson("data/live.json");
  } catch {
    return;                                    // not published yet / transient blip
  }
  const rev = live && live.rev;
  if (!rev) return;
  if (rev !== lastLiveRev) {
    lastLiveRev = rev;
    // A device that receives a live update was actively watching the game —
    // count it, so "how many people watch live" is answerable in GA.
    trackEvent("live_score_update", { fixture_id: String(live.fixture_id ?? "") });
    // Bust the in-memory scoresheet cache for the live game so the open match /
    // upcoming view re-fetches the updated card, then reload + repaint in place.
    if (live.fixture_id != null) state.matchCache.delete(live.fixture_id);
    forceRefresh(true);
  }
}

// The site-wide header doubles as the team banner: it shows "Blazing Firebirds"
// on our own views and swaps to the team's own name on another team's pages —
// same display font, and a two-word name stacks (first word as the small gold
// eyebrow, the rest as the large cream line) exactly like our brand. A one-word
// name (e.g. "BYC") just shows the single large line. Because the header now
// carries the team's identity, the team pages drop their own in-page name header.
// The banner is also the "home" link for whoever it's showing: on our views it
// goes to our home, and on another team's pages it goes to THAT team's home —
// hopping between teams is done via the ladder, so the banner never reaches back
// past the current team's home page.
function setBrand(name, hash) {
  const host = document.getElementById("brand-text");
  if (!host) return;
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  const top = words.length >= 2 ? words[0] : "";
  const bottom = words.length >= 2 ? words.slice(1).join(" ") : (words[0] || "");
  host.innerHTML =
    (top ? `<span class="brand-text__top">${escapeHtml(top)}</span>` : "") +
    `<span class="brand-text__bottom">${escapeHtml(bottom)}</span>`;
  const brand = document.querySelector(".brand");
  if (brand) {
    if (hash) {
      brand.setAttribute("href", hash);
      brand.setAttribute("aria-label", `${name} — home`);
      brand.classList.remove("brand--static");
    } else {
      // No home target (the leaderboard is its own page) — render the title as
      // plain text, not a link.
      brand.removeAttribute("href");
      brand.setAttribute("aria-label", name);
      brand.classList.add("brand--static");
    }
  }
}

// Pull a division team id out of a "team/{id}/…" path or breadcrumb (null if it
// isn't one, or the id isn't a real other-division team).
function teamContextId(s) {
  if (!s || !s.startsWith("team/")) return null;
  const id = parseInt(s.split("/")[1], 10);
  return Number.isNaN(id) ? null : id;
}

// Resolve the name + home target the header should show for the current route.
// The banner carries the page's own title, the same way the team pages moved
// their name into it: "Leaderboard / Division 8" on the ladder (its in-page
// title is dropped), a division team's own name + team home on its pages
// (team landing / player / upcoming), otherwise us + our home. A match/player
// page reached FROM a team (the `from` breadcrumb) inherits that team's banner,
// so a scorecard opened from another team's page stays badged as that team.
function brandTarget(path, from) {
  if (path === "standings") {
    const div = state.standings?.division_name || "Division";
    // The leaderboard is a top-level page with no home to link back to, so the
    // banner title isn't a link (hash: null).
    return { name: `Leaderboard ${div}`, hash: null };
  }
  const ctx = teamContextId(path) ?? teamContextId(from);
  if (ctx != null && ctx !== TEAM_ID && isDivisionTeam(ctx)) {
    return { name: divTeamName(ctx), hash: `#team/${ctx}` };
  }
  return { name: "Blazing Firebirds", hash: "#" };
}

function render(skipScroll) {
  clearTimeout(heroFlipTimer);  // re-armed by the home / upcoming view when a hero is shown
  const { path, from } = parseHash();
  // Team / match / upcoming routes are tracked from their renderers AFTER
  // their data resolves, so the GA path carries names ("/team/anderson-aces",
  // "/match/byc-vs-renegades-2026-05-16") rather than opaque Spawtz ids (on
  // a cold direct hit the names aren't known yet at route time).
  if (!/^(team|match|upcoming)\//.test(path)) trackPageView(path);
  const bt = brandTarget(path, from);
  setBrand(bt.name, bt.hash);
  const app = document.getElementById("app");
  if (!skipScroll) {
    // The app-shell .scroll-pane is the single scroller; scroll it to the top
    // on navigation (window.scrollTo is a no-op now the document is locked).
    document.querySelector(".scroll-pane")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }
  if (path.startsWith("player/")) {
    const key = decodeURIComponent(path.slice("player/".length));
    renderPlayer(app, key, from);
  } else if (path.startsWith("match/")) {
    const fid = parseInt(path.slice("match/".length), 10);
    const ours = state.fixtures?.fixtures?.some(f => f.fixture_id === fid);
    if (ours) renderMatch(app, fid, from);
    else renderNeutralMatch(app, fid, from);
  } else if (path.startsWith("upcoming/")) {
    const fid = parseInt(path.slice("upcoming/".length), 10);
    renderUpcoming(app, fid, from);
  } else if (path === "standings") {
    renderStandings(app, from);
  } else if (path.startsWith("team/")) {
    const parts = path.split("/");
    const teamId = parseInt(parts[1], 10);
    if (parts[2] === "player") {
      renderTeamPlayer(app, teamId, decodeURIComponent(parts.slice(3).join("/")), from);
    } else if (parts[2] === "upcoming") {
      renderTeamUpcoming(app, teamId, parseInt(parts[3], 10), from);
    } else {
      renderTeam(app, teamId, from);
    }
  } else {
    renderHome(app);
  }
}

// --- Home view -------------------------------------------------------

// DEV PREVIEW — set to a fixture object to force the "Next Game" card to
// show example content (for previewing the layout before Spawtz posts one).
// Leave as null for live data.
const DEMO_NEXT_GAME = null;

// DEV/TEST — add ?demo (or ?demo=N) to the URL to watch the hero's live flip:
// the next game's start is shifted to ~N seconds (default 60) from page load,
// rounded up to the whole minute, so NEXT GAME → LIVE GAME → PLAYED GAME play
// out in real time. Inert without the param. Fixed at load (not per-render).
const DEMO_START = (() => {
  const m = window.location.search.match(/[?&]demo(?:=(\d+))?/);
  if (!m) return null;
  const leadSec = m[1] ? parseInt(m[1], 10) : 60;
  return Math.ceil((Date.now() + leadSec * 1000) / 60000) * 60000;
})();

// In demo mode the game lasts this short window (seconds, default 10; override
// with ?dur=N) instead of the real hour, so the LIVE → COMPLETED flip can be
// watched too. null in normal use, so production always uses GAME_DURATION_MS.
const DEMO_DURATION_MS = (() => {
  if (DEMO_START == null) return null;
  const m = window.location.search.match(/[?&]dur=(\d+)/);
  return (m ? parseInt(m[1], 10) : 10) * 1000;
})();

function gameDurationMs() {
  return DEMO_DURATION_MS != null ? DEMO_DURATION_MS : GAME_DURATION_MS;
}

function demoDateTime(ts) {
  const d = new Date(ts);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const wk = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const p2 = n => String(n).padStart(2, "0");
  return {
    date_str: `${wk[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`,
    time: `${p2(d.getHours())}:${p2(d.getMinutes())}`,
  };
}

// Apply the ?demo timing override to the next game (the one in the hero and on
// its upcoming page). Gated to that fixture so no other fixture is ever shifted.
function applyDemoTiming(f) {
  const ng = state.fixtures && state.fixtures.next_game;
  if (DEMO_START != null && f && ng && f.fixture_id === ng.fixture_id) {
    return { ...f, ...demoDateTime(DEMO_START), played: false };
  }
  return f;
}

function currentHeroGame() {
  return applyDemoTiming(DEMO_NEXT_GAME || (state.fixtures && state.fixtures.next_game) || null);
}

function renderHome(app) {
  const { team, fixtures, players } = state;
  const next = currentHeroGame();
  scheduleHeroFlip(next ? parseSpawtzDate(next.date_str, next.time) : null);
  const filtered = filteredResults(fixtures.fixtures, state.resultsFilter);

  app.innerHTML = `
    ${heroHtml(next)}
    <div class="chip-row">
      ${installChipHtml()}
      ${notifyChipHtml()}
    </div>
    ${recordHtml(team.record)}
    <section class="section">
      <h2 class="section-title">Results</h2>
      <div class="results">
        ${resultsListHtml(filtered, state.resultsVisible)}
      </div>
    </section>
    <section class="section">
      <h2 class="section-title">Squad</h2>
      <div class="squad">
        ${sortedSquad(players.players).map(p => playerCardHtml(p)).join("")}
      </div>
    </section>
  `;
  wireResultClicks(app);
  wireShowMore(app);
  wireRecordFilters(app);
  wirePlayerClicks(app);
  wireInstallChip(app);
  wireNotifyChip(app);
}

// --- Leaderboard view ------------------------------------------------
// Full division ladder from data/standings.json. Presented neutrally (no back
// link, no highlight of our own row) so it works as a shareable entry point for
// any team in the division. Reached from the home record card's 4th cell.
function renderStandings(app, from) {
  const standings = state.standings;
  const teams = standings?.teams || [];

  if (!teams.length) {
    const msg = navigator.onLine
      ? "Leaderboard not available yet."
      : "Currently offline — Please check your connection";
    app.innerHTML = `<div class="loading">${msg}</div>`;
    return;
  }

  const rows = teams.map(t => {
    const diff = t.difference > 0 ? `+${t.difference}` : `${t.difference}`;
    // Every row is clickable — including ours: navigating to our own team id
    // is redirected to home by renderTeam, so our row opens our dashboard.
    const target = `team/${t.team_id}`;
    return `
      <tr class="ladder-row" data-target-hash="${escapeHtml(target)}">
        <td class="num ladder-pos">${t.position}</td>
        <td class="ladder-team">${escapeHtml(t.name)}</td>
        <td class="num">${t.played}</td>
        <td class="num">${t.won}</td>
        <td class="num">${t.lost}</td>
        <td class="num dk-only">${t.drawn}</td>
        <td class="num dk-only">${t.skins_for}</td>
        <td class="num dk-only">${t.skins_against}</td>
        <td class="num dk-only">${diff}</td>
        <td class="num ladder-pts">${t.points}</td>
      </tr>`;
  }).join("");

  app.innerHTML = `
    <div class="table-card">
      <table class="table table--ladder">
        <thead>
          <th class="num-h" data-tip="Ladder position" aria-label="Ladder position">#</th>
          <th class="ladder-team-h">Team</th>
          <th class="num-h" data-tip="Played" aria-label="Played">P</th>
          <th class="num-h" data-tip="Won" aria-label="Won">W</th>
          <th class="num-h" data-tip="Lost" aria-label="Lost">L</th>
          <th class="num-h dk-only" data-tip="Drawn" aria-label="Drawn">D</th>
          <th class="num-h dk-only" data-tip="Runs (skins) for" aria-label="Runs for">F</th>
          <th class="num-h dk-only" data-tip="Runs (skins) against" aria-label="Runs against">A</th>
          <th class="num-h dk-only" data-tip="Run difference" aria-label="Run difference">Dif</th>
          <th class="num-h" data-tip="Points" aria-label="Points">Pts</th>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
  wireRowNavigation(app);
}

// ====================================================================
// Division team pages (Phase 2) — every OTHER team in our division gets
// the same view we give ourselves (hero, results, squad, per-player
// pages), minus our private layers (schedule planning, push/calendar/
// reports). Other-team players are keyed/shown VERBATIM — never folded
// onto our roster. Data: data/division/{teamId}.json (built by
// build-division.py), the leaderboard (standings.json) links into them.
// ====================================================================

function divTeamName(teamId) {
  const t = state.standings?.teams?.find(x => x.team_id === teamId);
  if (t) return t.name;
  return state.divisionTeams.get(teamId)?.team?.name || "Team";
}

// Only teams CURRENTLY in our division are navigable. Out-of-division teams
// (grading opponents, or teams since promoted/relegated like Renegades) appear
// in game histories but have no team/player pages — so they're never links.
function isDivisionTeam(teamId) {
  return !!state.standings?.teams?.some(x => x.team_id === teamId);
}

function teamInitials(name) {
  return String(name || "").split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 3).join("").toUpperCase() || "?";
}

// Other-team player display: verbatim, title-cased, 'Unknown' placeholder stripped.
function plainName(name) {
  return String(name || "")
    .split(/\s+/)
    .filter(w => w && w.toLowerCase() !== "unknown")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function playerSlug(name) {
  return plainName(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function teamSideOf(f, teamId) {
  const home = f.home.id === teamId;
  return { side: home ? f.home : f.away, skins: home ? f.home_skins : f.away_skins };
}
function teamOppOf(f, teamId) {
  const home = f.home.id === teamId;
  return { side: home ? f.away : f.home, skins: home ? f.away_skins : f.home_skins };
}

// Map a team's display name (from a scoresheet) back to its Spawtz TeamId via
// the leaderboard, so a neutral scorecard can link players to their team page.
function resolveTeamIdByName(name) {
  const n = String(name || "").trim().toLowerCase();
  const t = state.standings?.teams?.find(x => (x.name || "").trim().toLowerCase() === n);
  return t ? t.team_id : null;
}

// Resolve a player slug to a record in a team file. Exact slug, then unique
// first-name, then nearest spelling — so a raw scorecard name ('Ollie') still
// lands on the merged record ('Olly Hampshire').
function findDivisionPlayer(data, key) {
  const players = data.players || [];
  let p = players.find(x => playerSlug(x.name) === key);
  if (p) return p;
  const fk = key.split("-")[0];
  const fn = players.filter(x => playerSlug(x.name).split("-")[0] === fk);
  if (fn.length === 1) return fn[0];
  p = players.find(x => levenshtein(playerSlug(x.name), key) <= 2);
  return p || null;
}

async function loadDivisionTeam(teamId) {
  if (state.divisionTeams.has(teamId)) return state.divisionTeams.get(teamId);
  const ck = `firebirds.cache.div.${teamId}`;
  let data = null;
  try {
    const r = await fetch(dataUrl(`data/division/${teamId}.json`), { cache: "no-store" });
    if (r.ok) data = await r.json();
  } catch (e) { /* offline — fall back to cache */ }
  if (!data) data = readCachedJson(ck);
  else writeCachedJson(ck, data);
  if (data) state.divisionTeams.set(teamId, data);
  return data;
}

function linkRowAttrs(hash) {
  if (!hash) return "";
  return `class="player-row" data-target-hash="${escapeHtml(hash)}"`;
}

// --- Team hero / record / cards (mirror the home versions, team-relative) ---

function teamHeroHtml(next, teamId) {
  if (!next) {
    return `
      <div class="hero hero--empty">
        <div class="hero__label">Next game</div>
        <div class="hero__date">Not yet posted</div>
        <p>No upcoming fixture posted yet. This updates automatically.</p>
      </div>`;
  }
  const opp = teamOppOf(next, teamId).side.display;
  const dt = parseSpawtzDate(next.date_str, next.time);
  const dayShort = dt ? dt.toLocaleDateString("en-NZ", { weekday: "short" }).toUpperCase() : "";
  const dayNum = dt ? String(dt.getDate()) : "";
  const monShort = dt ? dt.toLocaleDateString("en-NZ", { month: "short" }).toUpperCase() : "";
  const countdown = dt ? countdownText(dt) : "";
  const inner = `
    <div class="hero">
      <div class="hero__topbar">
        <div class="hero__label">${heroLabel(dt)}</div>
        ${countdown ? `<div class="hero__pill${gamePhase(dt) === "live" ? " hero__pill--live" : ""}">${escapeHtml(countdown)}</div>` : ""}
      </div>
      <div class="hero__body">
        <div class="hero__tile">
          <div class="hero__tile-day">${escapeHtml(dayShort)}</div>
          <div class="hero__tile-num">${escapeHtml(dayNum)}</div>
          <div class="hero__tile-mon">${escapeHtml(monShort)}</div>
        </div>
        <div class="hero__info">
          <div class="hero__vs">vs</div>
          <div class="hero__opp">${escapeHtml(opp)}</div>
          <div class="hero__when"><strong>${escapeHtml(formatTime12(next.time))}</strong> · ${escapeHtml(next.court)}</div>
        </div>
      </div>
    </div>`;
  // Other teams' next-game hero is display-only — its upcoming page has nothing
  // useful (no planned lineup etc.), so the card isn't a link.
  return inner;
}

function teamRecordHtml(data) {
  const rec = data.record;
  if (!rec) return "";
  const filter = state.teamFilter;
  const cell = (key, num, label) => {
    const active = filter === key ? ' data-active="true"' : "";
    return `
      <button type="button" class="record__cell" data-filter="${key}"${active}>
        <div class="record__num">${num}</div>
        <div class="record__label">${label}</div>
      </button>`;
  };
  const pos = data.standings_row?.position;
  const ladder = `
      <a class="record__cell record__cell--link" href="#standings" aria-label="View the leaderboard">
        <div class="record__num">${ordinal(pos)}</div>
        <div class="record__label">Ladder ›</div>
      </a>`;
  return `<div class="record">${cell("played", rec.played, "Played")}${cell("won", rec.won, "Won")}${cell("lost", rec.lost, "Lost")}${ladder}</div>`;
}

function teamFilteredResults(fixtures, teamId, filter) {
  const played = (fixtures || []).filter(f => f.played && f.scoresheet_complete);
  if (filter === "won") return played.filter(f => teamSideOf(f, teamId).skins > teamOppOf(f, teamId).skins);
  if (filter === "lost") return played.filter(f => teamSideOf(f, teamId).skins < teamOppOf(f, teamId).skins);
  return played;
}

function teamResultsListHtml(played, teamId, visible) {
  if (!played.length) {
    const msg = state.teamFilter === "won" ? "No wins yet"
      : state.teamFilter === "lost" ? "No losses yet" : "No matches yet";
    return `<div class="result-card"><div><div class="result-card__opp">${msg}</div></div></div>`;
  }
  const reversed = played.slice().reverse();   // newest first
  const shown = reversed.slice(0, visible);
  const hasMore = reversed.length > visible;
  return shown.map(f => teamResultCardHtml(f, teamId)).join("") +
    (hasMore ? `<button type="button" class="show-more-btn" data-action="show-more">Show more</button>` : "");
}

function teamResultCardHtml(f, teamId) {
  const us = teamSideOf(f, teamId).skins;
  const opp = teamOppOf(f, teamId);
  const them = opp.skins;
  // "Not in Div" chip when this team played someone no longer in the division.
  const oppId = opp.side.id;
  const outOfDiv = f.played && oppId && !isDivisionTeam(oppId);
  let badge = "", cls = "result-card--upcoming";
  if (f.played) {
    if (us > them) { badge = `<span class="badge badge--win">Win</span>`; cls = "result-card--win"; }
    else if (us < them) { badge = `<span class="badge badge--loss">Loss</span>`; cls = "result-card--loss"; }
    else { badge = `<span class="badge badge--loss">Draw</span>`; cls = "result-card--loss"; }
  } else {
    badge = `<span class="badge badge--upcoming">Upcoming</span>`;
  }
  const scoreText = f.played
    ? `<span class="result-card__score--us">${us}</span><span class="result-card__score-sep">–</span>${them}`
    : `<small>vs</small>`;
  return `
    <div class="result-card ${cls}" data-fixture-id="${f.fixture_id ?? ""}">
      <div>
        <div class="result-card__date"><span class="result-card__day">${escapeHtml(f.date_str ?? "")}</span><span class="result-card__badges">${badge}${outOfDiv ? `<span class="badge badge--neutral">Not in Div</span>` : ""}</span></div>
        <div class="result-card__opp">${escapeHtml(opp.side.display)}</div>
        <div class="result-card__meta">${escapeHtml(formatTime12(f.time))} · ${escapeHtml(f.court)}${f.is_grading ? " · Grading" : ""}</div>
      </div>
      <div class="result-card__score">${scoreText}</div>
    </div>`;
}

// Other-team squad order mirrors ours (regulars first, fill-ins last) — but the
// core/fill-in split is games played: 2+ games sort first, one-or-none sink to
// the bottom (same threshold as the gold/grey avatar). Display-only; our own
// home squad keeps its roster-based sortedSquad().
function sortedTeamSquad(players) {
  return [...players].sort((a, b) => {
    const ag = a.matches.length, bg = b.matches.length;
    if (ag !== bg) return bg - ag;
    const ar = a.totals?.runs ?? 0, br = b.totals?.runs ?? 0;
    if (ar !== br) return br - ar;
    return plainName(a.name).localeCompare(plainName(b.name));
  });
}

function teamPlayerCardHtml(p, teamId) {
  const t = p.totals;
  const shown = plainName(p.name);
  const initials = shown.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
  // A regular for their team (2+ games) gets the gold avatar like our core kids;
  // a one-game-or-less player gets the grey "stand-in" treatment.
  const regular = p.matches.length >= 2;
  return `
    <a class="player-card${regular ? "" : " player-card--standin"}" href="#${escapeHtml(makeHash(`team/${teamId}/player/${playerSlug(p.name)}`, `team/${teamId}`))}">
      <div class="player-card__avatar">${escapeHtml(initials)}</div>
      <div class="player-card__name">${escapeHtml(shown)}</div>
      <div class="player-card__stats">
        <div class="player-card__stat"><strong>${t.runs}</strong><span>Runs</span></div>
        <div class="player-card__stat"><strong>${t.wickets}</strong><span>Wkts</span></div>
        <div class="player-card__stat"><strong>${p.matches.length}</strong><span>Games</span></div>
      </div>
    </a>`;
}

// --- Team home --------------------------------------------------------

async function renderTeam(app, teamId, from) {
  if (teamId === TEAM_ID) { window.location.hash = ""; return; }
  // No back link on a team landing page — the leaderboard is reached via the
  // record card's "Ladder ›" cell (and the banner is the team's own home).
  app.innerHTML = `<div class="loading">Loading team…</div>`;
  const data = await loadDivisionTeam(teamId);
  trackPageView(`team/${teamId}`);
  if (!data) {
    const msg = navigator.onLine ? "Team not found." : "Currently offline — Please check your connection";
    app.innerHTML = `<div class="loading">${msg}</div>`;
    return;
  }
  // Reset the results filter/page only when arriving at a DIFFERENT team — not
  // on an in-place re-render driven by a filter tap or "Show more".
  if (state.teamFilterFor !== teamId) {
    state.teamFilter = "played";
    state.teamVisible = 3;
    state.teamFilterFor = teamId;
  }
  paintTeam(app, data, teamId, from);
}

// Synchronous paint — re-run for filter taps / show-more with no reload flash.
function paintTeam(app, data, teamId, from) {
  const next = data.next_game;
  scheduleHeroFlip(next ? parseSpawtzDate(next.date_str, next.time) : null);
  const filtered = teamFilteredResults(data.fixtures, teamId, state.teamFilter);
  app.innerHTML = `
    ${teamHeroHtml(next, teamId)}
    ${teamRecordHtml(data)}
    <section class="section">
      <h2 class="section-title">Results</h2>
      <div class="results">${teamResultsListHtml(filtered, teamId, state.teamVisible)}</div>
    </section>
    <section class="section">
      <h2 class="section-title">Squad</h2>
      <div class="squad">${sortedTeamSquad(data.players || []).map(p => teamPlayerCardHtml(p, teamId)).join("")}</div>
    </section>
  `;
  wireTeamResultClicks(app, teamId);
  app.querySelectorAll(".record__cell[data-filter]").forEach(el => {
    el.addEventListener("click", () => {
      const f = el.getAttribute("data-filter");
      if (f === state.teamFilter) return;
      trackEvent("results_filter", { filter: f, page: "team" });
      state.teamFilter = f;
      state.teamVisible = 3;
      paintTeam(app, data, teamId, from);
    });
  });
  const moreBtn = app.querySelector('[data-action="show-more"]');
  if (moreBtn) moreBtn.addEventListener("click", () => {
    trackEvent("results_show_more", { page: "team" });
    state.teamVisible += 3;
    paintTeam(app, data, teamId, from);
  });
}

function wireTeamResultClicks(scope, teamId) {
  scope.querySelectorAll(".result-card[data-fixture-id]").forEach(el => {
    const fid = el.getAttribute("data-fixture-id");
    if (!fid) return;
    el.addEventListener("click", () => { window.location.hash = makeHash(`match/${fid}`, `team/${teamId}`); });
  });
}
// --- Team player page -------------------------------------------------

async function renderTeamPlayer(app, teamId, key, from) {
  const backHash = from || `team/${teamId}`;
  const backLabel = "Back to " + divTeamName(teamId);
  const backHtml = `<a class="back" href="#${escapeHtml(backHash)}">‹ ${escapeHtml(backLabel)}</a>`;
  app.innerHTML = `${backHtml}<div class="loading">Loading…</div>`;
  const data = await loadDivisionTeam(teamId);
  trackPageView(`team/${teamId}/player/${key}`);
  if (!data) {
    const msg = navigator.onLine ? "Player not found." : "Currently offline — Please check your connection";
    app.innerHTML = `${backHtml}<div class="loading">${msg}</div>`;
    return;
  }
  const player = findDivisionPlayer(data, key);
  if (!player) {
    app.innerHTML = `${backHtml}<div class="loading">Player not found.</div>`;
    return;
  }
  const t = player.totals;
  const shown = plainName(player.name);
  const initials = shown.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
  const fromHere = `team/${teamId}/player/${playerSlug(player.name)}`;
  const hsBest = bestBattingMatch(player.matches);
  const bbBest = bestBowlingMatch(player.matches);
  const cleanOpp = (vs) => escapeHtml((vs || "").replace(/^['"]+|['"]+$/g, "").trim());
  const hlChip = (fid, label, valueHtml, vs) =>
    `<a class="hl" href="#${escapeHtml(makeHash(`match/${fid}`, fromHere))}">
        <span class="hl__chev" aria-hidden="true">›</span>
        <span class="hl__label">${label}</span>
        <span class="hl__val">${valueHtml}</span>
        <span class="hl__ctx">vs ${cleanOpp(vs)}</span>
      </a>`;
  const hlChips = [];
  if (hsBest) hlChips.push(hlChip(hsBest.fid, "High score batting", `${hsBest.r} <span class="hl__unit">runs</span>`, hsBest.vs));
  if (bbBest) hlChips.push(hlChip(bbBest.fid, "Best bowling", `${bbBest.w}/${bbBest.rc} <span class="hl__unit">(wickets / runs)</span>`, bbBest.vs));
  const highlightsHtml = hlChips.length ? `<div class="hl-row">${hlChips.join("")}</div>` : "";

  const matchRows = [...player.matches]
    .sort((a, b) => (b.fixture_id ?? 0) - (a.fixture_id ?? 0))
    .map(m => {
      const dmy = formatDateDMY(m.date_str);
      const [dd, mm, yy] = dmy.split("/");
      const dateCell = yy ? `${dd}/${mm}<span class="yr">/${yy}</span>` : escapeHtml(dmy);
      const bRuns = m.batting?.runs, bBalls = m.batting?.balls_faced;
      const wk = m.bowling?.wickets, rc = m.bowling?.runs_conceded, ov = m.bowling?.overs;
      const srCell = (bRuns != null && bBalls) ? strikeRate(bRuns, bBalls) : "—";
      const erCell = (rc != null && ov) ? economyRate(rc, ov) : "—";
      return `
        <tr class="player-row" data-fixture-id="${m.fixture_id}">
          <td class="date-col">${dateCell}</td>
          <td class="opp"><span class="opp-text">${escapeHtml(m.vs ?? "")}</span></td>
          <td class="num">${bRuns ?? "—"}</td>
          <td class="num">${srCell}</td>
          <td class="num">${wk ?? "—"}</td>
          <td class="num">${erCell}</td>
        </tr>`;
    }).join("");

  app.innerHTML = `
    ${backHtml}
    <div class="detail-header detail-header--player">
      <div class="detail-header__main">
        <div class="detail-header__avatar">${escapeHtml(initials)}</div>
        <div>
          <div class="detail-header__name">${escapeHtml(shown)}</div>
          <div class="detail-header__sub">${player.matches.length} match${player.matches.length === 1 ? "" : "es"} for ${escapeHtml(divTeamName(teamId))}</div>
        </div>
      </div>
      ${highlightsHtml}
    </div>

    <h3 class="subhead">Batting</h3>
    <div class="stat-grid">
      <div class="stat-grid__cell"><div class="stat-grid__num">${t.runs}</div><div class="stat-grid__label">Total runs</div></div>
      <div class="stat-grid__cell"><div class="stat-grid__num">${t.balls_faced}</div><div class="stat-grid__label">Balls faced</div></div>
      <div class="stat-grid__cell"><div class="stat-grid__num">${t.dismissals}</div><div class="stat-grid__label">Outs</div></div>
    </div>

    <h3 class="subhead">Bowling</h3>
    <div class="stat-grid">
      <div class="stat-grid__cell"><div class="stat-grid__num">${t.wickets}</div><div class="stat-grid__label">Wickets</div></div>
      <div class="stat-grid__cell"><div class="stat-grid__num">${t.overs_bowled}</div><div class="stat-grid__label">Overs bowled</div></div>
      <div class="stat-grid__cell"><div class="stat-grid__num">${t.runs_conceded}</div><div class="stat-grid__label">Runs conceded</div></div>
    </div>

    <h3 class="subhead">Match-by-match</h3>
    ${player.matches.length === 0
      ? `<div class="upcoming-shell"><p class="upcoming-shell__hint">Yet to play a game</p></div>`
      : `<div class="table-card">
      <table class="table table--player-matches">
        <thead><tr>
          <th class="date-col">Date</th>
          <th>Opponent</th>
          <th class="num-h" data-tip="Runs scored" aria-label="Runs scored">R</th>
          <th class="num-h" data-tip="Strike rate — runs ÷ balls × 100" aria-label="Strike rate">SR</th>
          <th class="num-h" data-tip="Wickets taken" aria-label="Wickets taken">W</th>
          <th class="num-h" data-tip="Economy rate — runs ÷ overs" aria-label="Economy rate">ER</th>
        </tr></thead>
        <tbody>${matchRows}</tbody>
      </table>
    </div>`}
  `;
  app.querySelectorAll(".player-row[data-fixture-id]").forEach(el => {
    const fid = el.getAttribute("data-fixture-id");
    if (!fid) return;
    el.addEventListener("click", () => { window.location.hash = makeHash(`match/${fid}`, fromHere); });
  });
}

// --- Team upcoming game (Spawtz-only — no planned lineups) -------------

async function renderTeamUpcoming(app, teamId, fid, from) {
  const backHash = from || `team/${teamId}`;
  const backHtml = `<a class="back" href="#${escapeHtml(backHash)}">‹ Back to ${escapeHtml(divTeamName(teamId))}</a>`;
  app.innerHTML = `${backHtml}<div class="loading">Loading…</div>`;
  const data = await loadDivisionTeam(teamId);
  if (!data) {
    trackPageView(`team/${teamId}/upcoming/${fid}`);
    const msg = navigator.onLine ? "Fixture not found." : "Currently offline — Please check your connection";
    app.innerHTML = `${backHtml}<div class="loading">${msg}</div>`;
    return;
  }
  const fixture = (data.fixtures || []).find(f => f.fixture_id === fid);
  if (!fixture) {
    trackPageView(`team/${teamId}/upcoming/${fid}`);
    app.innerHTML = `${backHtml}<div class="loading">Fixture not found.</div>`;
    return;
  }
  // (Hand-off untracked — the match page records the redirected view.)
  if (fixture.played && fixture.scoresheet_complete) {
    window.location.hash = makeHash(`match/${fid}`, backHash);
    return;
  }
  trackPageView(`team/${teamId}/upcoming/${fid}`, gaFixtureOverride(fixture, "team-upcoming", teamId));
  const oppName = teamOppOf(fixture, teamId).side.display;
  const dt = parseSpawtzDate(fixture.date_str, fixture.time);
  scheduleHeroFlip(dt);
  const awaiting = gamePhase(dt) === "finished" && !fixture.scoresheet_complete;
  const dateLabel = dt
    ? dt.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "long" })
    : (fixture.date_str ?? "");
  const countdown = dt ? countdownText(dt) : "";
  const oppInitial = ((oppName || "").match(/[A-Za-z]/) || ["?"])[0].toUpperCase();
  app.innerHTML = `
    ${backHtml}
    <div class="detail-header">
      <div class="detail-header__main">
        <div class="detail-header__avatar">vs</div>
        <div>
          <div class="detail-header__name">${escapeHtml(divTeamName(teamId))} vs ${escapeHtml(oppName)}</div>
          <div class="detail-header__sub">${escapeHtml(dateLabel)} · ${escapeHtml(formatTime12(fixture.time))} · ${escapeHtml(fixture.court || "")}</div>
        </div>
      </div>
    </div>
    ${awaiting
      ? `<div class="upcoming-shell"><p class="upcoming-shell__title">Awaiting scores to be added</p><p class="upcoming-shell__hint">The scoresheet will appear here once it's posted.</p></div>`
      : `<div class="hero">
          <div class="hero__topbar"><div class="hero__label">${heroLabel(dt)}</div>${countdown ? `<div class="hero__pill${gamePhase(dt) === "live" ? " hero__pill--live" : ""}">${escapeHtml(countdown)}</div>` : ""}</div>
          <div class="hero__body">
            <div class="hero__tile"><div class="hero__tile-num">${escapeHtml(oppInitial)}</div></div>
            <div class="hero__info"><div class="hero__vs">vs</div><div class="hero__opp">${escapeHtml(oppName)}</div><div class="hero__when"><strong>${escapeHtml(formatTime12(fixture.time))}</strong> · ${escapeHtml(fixture.court || "")}</div></div>
          </div>
        </div>`}
  `;
}

// --- Neutral match scorecard (a game between two OTHER teams) ----------
// Reached only from a team context (a team's result card or a team player's
// game), so `from` carries a TeamId — we resolve the real team names/ids from
// that team's fixture list (the scoresheet header is just a captain nickname,
// not the team name), then render both sides neutrally with player links.

async function renderNeutralMatch(app, fid, from) {
  const backHash = from || "standings";
  const backLabel = from ? "Back" : "Back to Leaderboard";
  const backHtml = `<a class="back" href="#${escapeHtml(backHash)}">‹ ${escapeHtml(backLabel)}</a>`;
  app.innerHTML = `${backHtml}<div class="loading">Loading match…</div>`;

  let detail = state.matchCache.get(fid);
  if (!detail) {
    try {
      detail = await fetchJson(`data/matches/${fid}.json`);
      state.matchCache.set(fid, detail);
    } catch (err) {
      trackPageView(`match/${fid}`);
      const msg = navigator.onLine ? "Couldn't load match." : "Currently offline — Please check your connection";
      app.innerHTML = `${backHtml}<div class="loading">${msg}</div>`;
      return;
    }
  }

  // Find the fixture (reliable team names/ids) via the team we came from.
  let fixture = null;
  const hintId = from && from.startsWith("team/") ? parseInt(from.split("/")[1], 10) : null;
  if (hintId != null) {
    const d = await loadDivisionTeam(hintId);
    fixture = (d?.fixtures || []).find(f => f.fixture_id === fid) || null;
  }

  const innings = detail.innings || [];
  const summaries = detail.team_summaries || [];

  // Map summaries/innings to home/away. With a fixture we anchor on skins;
  // without one we fall back to scoresheet order + display names.
  let home, away, homeInn, awayInn, homeSum, awaySum;
  if (fixture) {
    // Lead with the team whose page we came from — their name goes first in the
    // title, not whoever Spawtz happened to list as the home side.
    let h = fixture.home, a = fixture.away, hs = fixture.home_skins, as = fixture.away_skins;
    if (hintId != null && a.id === hintId) {
      [h, a] = [a, h];
      [hs, as] = [as, hs];
    }
    home = { id: h.id, name: h.display, skins: hs };
    away = { id: a.id, name: a.display, skins: as };
    let idx = summaries.findIndex(s => s.total === home.skins);
    if (idx < 0) idx = 0;
    homeSum = summaries[idx] || null;
    awaySum = summaries[1 - idx] || null;
    homeInn = innings[idx] || null;
    awayInn = innings[1 - idx] || null;
  } else {
    homeInn = innings[0] || null;
    awayInn = innings[1] || null;
    homeSum = summaries[0] || null;
    awaySum = summaries[1] || null;
    const hName = homeInn?.batting_team_display || homeSum?.display || "Team A";
    const aName = awayInn?.batting_team_display || awaySum?.display || "Team B";
    home = { id: resolveTeamIdByName(hName), name: hName, skins: homeSum?.total };
    away = { id: resolveTeamIdByName(aName), name: aName, skins: awaySum?.total };
  }
  // Names are display values here (the fixture branch already swapped in the
  // came-from team first); date rides along only when the fixture is known.
  trackPageView(`match/${fid}`, gaFixtureOverride({
    home: { display: home.name }, away: { display: away.name },
    date_str: fixture?.date_str, time: fixture?.time,
  }, "match"));

  // Player rows are tappable only for teams in OUR division (out-of-division
  // grading opponents have no pages). Returns null → no row link.
  const hrefFor = (tid) => isDivisionTeam(tid)
    ? ((name) => makeHash(`team/${tid}/player/${playerSlug(name)}`, `match/${fid}`))
    : null;
  const homeHref = hrefFor(home.id);
  const awayHref = hrefFor(away.id);

  const hScore = homeSum?.total, aScore = awaySum?.total;
  const homeWon = hScore != null && aScore != null && hScore > aScore;
  const awayWon = hScore != null && aScore != null && aScore > hScore;
  const margin = (hScore != null && aScore != null) ? Math.abs(hScore - aScore) : null;
  const resultText = margin == null ? "" : margin === 0
    ? "Match drawn"
    : `${homeWon ? home.name : away.name} won by ${margin} run${margin === 1 ? "" : "s"}`;
  const dt = fixture ? parseSpawtzDate(fixture.date_str, fixture.time) : null;
  const dateLabel = dt
    ? dt.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "long" })
    : (fixture?.date_str || detail.date_str || "");

  // A "Team not in division" note above whichever side(s) aren't current
  // division teams, plus the greyed "inactive" treatment for that side's tables.
  // Only when ids came from a real fixture — in the no-fixture deeplink fallback
  // ids are resolved from scoresheet names (often captain nicknames) and would
  // mis-flag a genuine side. Each team's two tables are grouped into one block
  // so the out-of-division side can be greyed (and labelled) as a unit.
  const homeInactive = fixture && !isDivisionTeam(home.id);
  const awayInactive = fixture && !isDivisionTeam(away.id);
  const homeNote = homeInactive ? `<p class="match-note">Team not in division</p>` : "";
  const awayNote = awayInactive ? `<p class="match-note">Team not in division</p>` : "";
  const homeBlock = `
      ${homeNote}
      ${homeInn ? `<h3 class="subhead">${escapeHtml(home.name)} batting</h3>${battingTableHtml(homeInn.batters, { opponent: true, linkHref: homeHref })}` : ""}
      ${awayInn ? `<h3 class="subhead">${escapeHtml(home.name)} bowling</h3>${bowlingTableHtml(awayInn.bowlers, { opponent: true, linkHref: homeHref })}` : ""}
  `;
  const awayBlock = `
      ${awayNote}
      ${awayInn ? `<h3 class="subhead">${escapeHtml(away.name)} batting</h3>${battingTableHtml(awayInn.batters, { opponent: true, linkHref: awayHref })}` : ""}
      ${homeInn ? `<h3 class="subhead">${escapeHtml(away.name)} bowling</h3>${bowlingTableHtml(homeInn.bowlers, { opponent: true, linkHref: awayHref })}` : ""}
  `;

  app.innerHTML = `
    ${backHtml}
    <div class="detail-header">
      <div class="detail-header__main">
        <div class="detail-header__avatar">vs</div>
        <div>
          <div class="detail-header__name">${escapeHtml(home.name)} vs ${escapeHtml(away.name)}</div>
          <div class="detail-header__sub">${escapeHtml(dateLabel)}${fixture?.court ? ` · ${escapeHtml(formatTime12(fixture.time))} · ${escapeHtml(fixture.court)}` : ""}</div>
        </div>
      </div>
    </div>

    <div class="match-top">
      <div class="match-summary">
        <div class="match-summary__row ${awayWon ? "match-summary__row--lost" : ""}">
          <div class="match-summary__crest" aria-hidden="true">${escapeHtml(teamInitials(home.name))}</div>
          <div class="match-summary__name">${escapeHtml(home.name)}</div>
          <div class="match-summary__score">${hScore ?? "—"}</div>
        </div>
        <div class="match-summary__divider"><span class="match-summary__vs">vs</span></div>
        <div class="match-summary__row ${homeWon ? "match-summary__row--lost" : ""}">
          <div class="match-summary__crest" aria-hidden="true">${escapeHtml(teamInitials(away.name))}</div>
          <div class="match-summary__name">${escapeHtml(away.name)}</div>
          <div class="match-summary__score">${aScore ?? "—"}</div>
        </div>
        ${resultText ? `<div class="match-summary__result">${escapeHtml(resultText)}</div>` : ""}
      </div>
    </div>

    ${homeInactive ? `<div class="match-inactive">${homeBlock}</div>` : homeBlock}
    ${awayInactive ? `<div class="match-inactive">${awayBlock}</div>` : awayBlock}
  `;
  wireRowNavigation(app);
}

function filteredResults(fixtures, filter) {
  const played = fixtures.filter(f => f.played && f.scoresheet_complete);
  if (filter === "won") {
    return played.filter(f => {
      const isUs = f.home.id === TEAM_ID;
      const us = isUs ? f.home_skins : f.away_skins;
      const them = isUs ? f.away_skins : f.home_skins;
      return us > them;
    });
  }
  if (filter === "lost") {
    return played.filter(f => {
      const isUs = f.home.id === TEAM_ID;
      const us = isUs ? f.home_skins : f.away_skins;
      const them = isUs ? f.away_skins : f.home_skins;
      return us < them;
    });
  }
  return played;
}

function wireRecordFilters(app) {
  app.querySelectorAll(".record__cell[data-filter]").forEach(el => {
    el.addEventListener("click", () => {
      const next = el.getAttribute("data-filter");
      if (next === state.resultsFilter) return;
      trackEvent("results_filter", { filter: next, page: "home" });
      state.resultsFilter = next;
      state.resultsVisible = 3;
      renderHome(app);
    });
  });
}

function resultsListHtml(played, visible) {
  if (!played.length) {
    const msg = state.resultsFilter === "won" ? "No wins yet"
      : state.resultsFilter === "lost" ? "No losses yet"
      : "No matches yet";
    return `<div class="result-card"><div><div class="result-card__opp">${msg}</div></div></div>`;
  }
  const reversed = played.slice().reverse();
  const shown = reversed.slice(0, visible);
  const hasMore = reversed.length > visible;
  return shown.map(resultCardHtml).join("") +
    (hasMore ? `<button type="button" class="show-more-btn" data-action="show-more">Show more</button>` : "");
}

function wireShowMore(scope) {
  const btn = scope.querySelector('[data-action="show-more"]');
  if (!btn) return;
  btn.addEventListener("click", () => {
    trackEvent("results_show_more", { page: "home" });
    state.resultsVisible += 3;
    const filtered = filteredResults(state.fixtures.fixtures, state.resultsFilter);
    const container = scope.querySelector(".results");
    if (!container) return;
    container.innerHTML = resultsListHtml(filtered, state.resultsVisible);
    wireResultClicks(container);
    wireShowMore(scope);
  });
}

function heroHtml(next) {
  if (!next) {
    return `
      <div class="hero hero--empty">
        <div class="hero__label">Next game</div>
        <div class="hero__date">Not yet posted</div>
        <p>Awaiting fixture details. This page updates automatically as soon as they're posted.</p>
      </div>`;
  }
  const inner = heroCardHtml(next);
  const fid = next.fixture_id;
  return fid
    ? `<a class="hero-link" href="#upcoming/${escapeHtml(String(fid))}">${inner}</a>`
    : inner;
}

function heroCardHtml(next) {
  const opponent = opponentName(next);
  const dt = parseSpawtzDate(next.date_str, next.time);
  const dayShort = dt ? dt.toLocaleDateString("en-NZ", { weekday: "short" }).toUpperCase() : "";
  const dayNum = dt ? String(dt.getDate()) : "";
  const monShort = dt ? dt.toLocaleDateString("en-NZ", { month: "short" }).toUpperCase() : "";
  const countdown = dt ? countdownText(dt) : "";
  const iso = dt
    ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`
    : "";
  const captainName = state.schedule?.games?.[iso]?.captain || "";
  return `
    <div class="hero">
      <div class="hero__topbar">
        <div class="hero__label">${heroLabel(dt)}</div>
        ${countdown ? `<div class="hero__pill${gamePhase(dt) === "live" ? " hero__pill--live" : ""}">${escapeHtml(countdown)}</div>` : ""}
      </div>
      <div class="hero__body">
        <div class="hero__tile">
          <div class="hero__tile-day">${escapeHtml(dayShort)}</div>
          <div class="hero__tile-num">${escapeHtml(dayNum)}</div>
          <div class="hero__tile-mon">${escapeHtml(monShort)}</div>
        </div>
        <div class="hero__info">
          <div class="hero__vs">vs</div>
          <div class="hero__opp">${escapeHtml(opponent)}</div>
          <div class="hero__when">
            <strong>${escapeHtml(formatTime12(next.time))}</strong> · ${escapeHtml(next.court)}
          </div>
          ${captainName ? `<div class="hero__when"><strong>Captain:</strong> ${escapeHtml(resolveFullName(captainName))}</div>` : ""}
        </div>
      </div>
    </div>`;
}

async function renderUpcoming(app, fid, from) {
  const back = backTargetFor(from, "", "Back to Home");
  const backHtml = `<a class="back" href="#${escapeHtml(back.hash)}">‹ ${escapeHtml(back.label)}</a>`;

  const fromDemo = DEMO_NEXT_GAME && DEMO_NEXT_GAME.fixture_id === fid ? DEMO_NEXT_GAME : null;
  const fixture = fromDemo
    || state.fixtures?.fixtures?.find(f => f.fixture_id === fid)
    || (state.fixtures?.next_game?.fixture_id === fid ? state.fixtures.next_game : null);

  if (!fixture) {
    trackPageView(`upcoming/${fid}`);
    app.innerHTML = `${backHtml}<div class="loading">Fixture not found.</div>`;
    return;
  }

  // Once the scorecard has real game data, hand off to the match page.
  // (Untracked — the match page records the redirected view.)
  if (fixture.played && fixture.scoresheet_complete) {
    window.location.hash = makeHash(`match/${fid}`, from);
    return;
  }
  trackPageView(`upcoming/${fid}`, gaFixtureOverride(fixture, "upcoming"));

  const game = applyDemoTiming(fixture);
  const oppName = opponentName(game);
  const dt = parseSpawtzDate(game.date_str, game.time);
  scheduleHeroFlip(dt);
  const awaiting = gamePhase(dt) === "finished" && !fixture.scoresheet_complete;
  const dateLabel = dt
    ? dt.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "long" })
    : (fixture.date_str ?? "");
  const countdown = dt ? countdownText(dt) : "";
  const oppInitial = ((oppName || "").match(/[A-Za-z]/) || ["?"])[0].toUpperCase();
  const iso = dt
    ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`
    : "";
  const sched = state.schedule?.games?.[iso] || null;
  const partnerships = sched?.partnerships || null;
  const bowlingOrder = sched?.bowling_order || null;
  const captainName = sched?.captain || "";

  // If the game is live (played but scorecard not yet complete), try to load
  // whatever partial innings data Spawtz has posted so far. Show real stats
  // for completed innings; fall back to planned lineup for innings not yet done.
  let fbInnings = null, oppInnings = null, fbLiveScore = null, oppLiveScore = null;
  if (fixture.played && !fixture.scoresheet_complete) {
    try {
      const detail = state.matchCache.get(fid) || await fetchJson(`data/matches/${fid}.json`);
      if (detail) {
        state.matchCache.set(fid, detail);
        const isUsHome = fixture.home.id === TEAM_ID;
        const summaries = detail.team_summaries || [];
        const usSkins = isUsHome ? fixture.home_skins : fixture.away_skins;
        const fbSummary = summaries.find(s => s.total === usSkins) || summaries[0];
        const fbIdx = summaries.indexOf(fbSummary);
        const allInnings = detail.innings || [];
        const fbCand  = fbIdx >= 0 ? allInnings[fbIdx] : allInnings[0];
        const oppCand = fbIdx >= 0 ? allInnings[1 - fbIdx] : allInnings[1];
        // Only surface an innings when it has real balls-faced / overs data.
        if (fbCand  && (fbCand.batters  || []).some(b => (b.balls_faced || 0) > 0)) {
          fbInnings = fbCand;
          fbLiveScore = fbSummary?.total ?? null;
        }
        if (oppCand && (oppCand.batters || []).some(b => (b.balls_faced || 0) > 0)) {
          oppInnings = oppCand;
          oppLiveScore = (summaries.find(s => s !== fbSummary))?.total ?? null;
        }
      }
    } catch (_) { /* no match file yet — that's fine */ }
  }

  app.innerHTML = `
    ${backHtml}
    <div class="detail-header">
      <div class="detail-header__topbar">
        <div class="hero__label">${heroLabel(dt)}</div>
        ${countdown ? `<div class="hero__pill${gamePhase(dt) === "live" ? " hero__pill--live" : ""}">${escapeHtml(countdown)}</div>` : ""}
      </div>
      <div class="detail-header__main">
        <div class="detail-header__avatar">vs</div>
        <div>
          <div class="detail-header__name">${escapeHtml(TEAM_DISPLAY)} vs ${escapeHtml(oppName)}</div>
          <div class="detail-header__sub">${escapeHtml(dateLabel)} · ${escapeHtml(formatTime12(fixture.time))} · ${escapeHtml(fixture.court)}</div>
          ${captainName ? `<div class="detail-header__sub"><strong>Captain:</strong> ${escapeHtml(resolveFullName(captainName))}</div>` : ""}
        </div>
      </div>
    </div>

    <div class="match-summary">
      <div class="match-summary__row">
        <div class="match-summary__crest match-summary__crest--us" aria-hidden="true">
          <svg viewBox="0 0 64 64">
            <path d="M32 4 C 24 16, 18 22, 18 32 C 18 42, 24 50, 24 50 C 22 44, 22 38, 26 34 C 26 40, 28 46, 32 50 C 36 46, 38 40, 38 34 C 42 38, 42 44, 40 50 C 40 50, 46 42, 46 32 C 46 22, 40 16, 32 4 Z" fill="#0E353D"/>
          </svg>
        </div>
        <div class="match-summary__name">${escapeHtml(TEAM_DISPLAY)}</div>
        <div class="match-summary__score">${fbLiveScore !== null ? fbLiveScore : "—"}</div>
      </div>
      <div class="match-summary__divider"><span class="match-summary__vs">vs</span></div>
      <div class="match-summary__row">
        <div class="match-summary__crest" aria-hidden="true">${escapeHtml(oppInitial)}</div>
        <div class="match-summary__name">${escapeHtml(oppName)}</div>
        <div class="match-summary__score">${oppLiveScore !== null ? oppLiveScore : "—"}</div>
      </div>
    </div>

    ${lineupCardHtml(iso)}

    ${awaiting ? `
    <div class="upcoming-shell">
      <p class="upcoming-shell__hint">Awaiting scores to be added</p>
    </div>` : `
    <h3 class="subhead">${escapeHtml(TEAM_DISPLAY)} batting</h3>
    ${fbInnings
      ? battingTableHtml(fbInnings.batters, { linkPlayers: true, matchId: fid, captain: captainName })
      : plannedBattingTableHtml(partnerships, captainName, fid)}
    <h3 class="subhead">${escapeHtml(TEAM_DISPLAY)} bowling</h3>
    ${oppInnings
      ? bowlingTableHtml(oppInnings.bowlers, { linkPlayers: true, matchId: fid, captain: captainName })
      : plannedBowlingTableHtml(bowlingOrder, captainName, fid)}
    <h3 class="subhead">${escapeHtml(oppName)} batting</h3>
    ${oppInnings
      ? battingTableHtml(oppInnings.batters, { opponent: true })
      : `<div class="upcoming-shell"><p class="upcoming-shell__hint">Batting to be updated</p></div>`}
    <h3 class="subhead">${escapeHtml(oppName)} bowling</h3>
    ${fbInnings
      ? bowlingTableHtml(fbInnings.bowlers, { opponent: true })
      : `<div class="upcoming-shell"><p class="upcoming-shell__hint">Bowling to be updated</p></div>`}`}
  `;
  wireRowNavigation(app);
}

// The Away / Reserves / Stand-ins box always shows first names only — even
// though a stand-in is now stored under their full name (so they can be
// seeded into players.json and shown with their full name in the lineup
// tables). Away/Reserves are already first-name entries, so this is a no-op
// for them and just enforces the convention.
function firstNameOnly(name) {
  return (name || "").trim().split(/\s+/)[0] || "";
}

function lineupCardHtml(iso) {
  const sched = state.schedule?.games?.[iso] || null;
  if (!sched) return "";
  const cols = [];
  if ((sched.unavailable || []).length) cols.push({ label: "Away", names: sched.unavailable });
  if ((sched.rotation || []).length) cols.push({ label: "Reserves", names: sched.rotation });
  if ((sched.stand_ins || []).length) cols.push({ label: "Stand-ins", names: sched.stand_ins });
  if (!cols.length) return "";
  return `
    <div class="lineup-card">
      ${cols.map(c => `
        <div>
          <div class="lineup-card__label">${escapeHtml(c.label)}</div>
          <div class="lineup-card__names">${escapeHtml(c.names.map(firstNameOnly).join(", "))}</div>
        </div>`).join("")}
    </div>`;
}

function resolveFullName(firstName) {
  if (!firstName) return "";
  const players = state.players?.players || [];
  const key = playerKey(firstName);
  let player = players.find(p => playerKey(p.name) === key);
  if (!player) {
    // Bare reference (e.g. "Vivaan") -> match a full-name-keyed stand-in by first name.
    const fk = firstNameKey(firstName);
    player = players.find(p => firstNameKey(p.name) === fk);
  }
  if (player) return displayName(player.name);
  return firstName.charAt(0).toUpperCase() + firstName.slice(1);
}

function plannedBattingTableHtml(partnerships, captain = "", fixtureId = null) {
  // Renders the partnerships table (with em-dashes for unplayed stats), or
  // the "to be updated" shell when no batters are filled in.
  const hasPlan = partnerships
    && partnerships.length === 3
    && partnerships.some(p => (p[0] || "").trim() || (p[1] || "").trim());
  if (!hasPlan) {
    return `
    <div class="upcoming-shell">
      <p class="upcoming-shell__hint">Batting to be updated</p>
    </div>`;
  }
  const captainKey = captain ? playerKey(captain) : "";
  const captainSuffix = first => (captainKey && first && playerKey(first) === captainKey) ? " (c)" : "";
  const ordinals = ["1st", "2nd", "3rd"];
  let body = "";
  for (let i = 0; i < 3; i++) {
    const [origA, origB] = partnerships[i];
    const a = resolveFullName(origA);
    const b = resolveFullName(origB);
    const cellA = a ? escapeHtml(a + captainSuffix(origA)) : "—";
    const cellB = b ? escapeHtml(b + captainSuffix(origB)) : "—";
    const linkA = origA ? rowLinkAttrs(origA, true, fixtureId, "upcoming") : "";
    const linkB = origB ? rowLinkAttrs(origB, true, fixtureId, "upcoming") : "";
    body += `
      <tr class="partnership-header">
        <td colspan="6">
          <div class="partnership-inner">
            <span class="partnership-tag">${ordinals[i]} partnership</span>
            <span class="partnership-runs">
              <span class="partnership-runs__num">—</span>
              <span class="partnership-runs__label">runs</span>
            </span>
          </div>
        </td>
      </tr>
      <tr ${linkA}><td>${cellA}</td><td class="num">—</td><td class="num">—</td><td class="num dk-only">—</td><td class="num dk-only">—</td><td class="num">—</td></tr>
      <tr ${linkB}><td>${cellB}</td><td class="num">—</td><td class="num">—</td><td class="num dk-only">—</td><td class="num dk-only">—</td><td class="num">—</td></tr>`;
  }
  return `
    <div class="table-card">
      <table class="table table--partnerships table--scorecard">
        <thead><tr>
          <th>Batters (in order)</th>
          <th class="num-h" data-tip="Runs scored" aria-label="Runs scored">R</th>
          <th class="num-h" data-tip="Balls faced" aria-label="Balls faced">B</th>
          <th class="num-h dk-only" data-tip="balls scoring 4 or 5" aria-label="Balls scoring 4 or 5">4+</th>
          <th class="num-h dk-only" data-tip="balls scoring 6 or more" aria-label="Balls scoring 6 or more">6+</th>
          <th class="num-h" data-tip="Strike rate — runs ÷ balls × 100" aria-label="Strike rate, runs divided by balls times 100">SR</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function plannedBowlingTableHtml(bowlingOrder, captain = "", fixtureId = null) {
  // Renders the planned bowling order table (em-dashes for unplayed stats),
  // or the "to be updated" shell when no bowlers are filled in.
  const hasPlan = Array.isArray(bowlingOrder)
    && bowlingOrder.some(n => (n || "").trim());
  if (!hasPlan) {
    return `
    <div class="upcoming-shell">
      <p class="upcoming-shell__hint">Bowling to be updated</p>
    </div>`;
  }
  const captainKey = captain ? playerKey(captain) : "";
  const rows = bowlingOrder.map(n => {
    const orig = (n || "").trim();
    const display = orig ? resolveFullName(orig) : "";
    const suffix = (captainKey && orig && playerKey(orig) === captainKey) ? " (c)" : "";
    const cell = display ? escapeHtml(display + suffix) : "—";
    const link = orig ? rowLinkAttrs(orig, true, fixtureId, "upcoming") : "";
    return `<tr ${link}><td>${cell}</td><td class="num">—</td><td class="num">—</td><td class="num dk-only">—</td><td class="num dk-only">—</td><td class="num">—</td></tr>`;
  }).join("");
  return `
    <div class="table-card">
      <table class="table table--scorecard">
        <thead><tr>
          <th>Bowlers (in order)</th>
          <th class="num-h" data-tip="Wickets taken" aria-label="Wickets taken">W</th>
          <th class="num-h" data-tip="Runs conceded" aria-label="Runs conceded">R</th>
          <th class="num-h dk-only" data-tip="Wides" aria-label="Wides">WD</th>
          <th class="num-h dk-only" data-tip="No-balls" aria-label="No-balls">NB</th>
          <th class="num-h" data-tip="Economy rate — runs ÷ overs" aria-label="Economy rate, runs divided by overs">ER</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}


function ordinal(n) {
  if (n == null || n <= 0) return "—";
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function recordHtml(record) {
  if (!record) return "";
  const filter = state.resultsFilter;
  const cell = (key, num, label) => {
    const active = filter === key ? ' data-active="true"' : "";
    return `
      <button type="button" class="record__cell" data-filter="${key}"${active}>
        <div class="record__num">${num}</div>
        <div class="record__label">${label}</div>
      </button>`;
  };
  // 4th cell: our ladder position — taps through to the full division table.
  const pos = state.team?.standings_row?.position;
  const teamCount = state.standings?.teams?.length;
  const ladderCell = `
      <a class="record__cell record__cell--link" href="#standings" aria-label="View the Division 8 leaderboard">
        <div class="record__num">${ordinal(pos)}</div>
        <div class="record__label">Ladder ›</div>
      </a>`;
  return `
    <div class="record">
      ${cell("played", record.played, "Played")}
      ${cell("won", record.won, "Won")}
      ${cell("lost", record.lost, "Lost")}
      ${ladderCell}
    </div>`;
}

function resultCardHtml(f) {
  const isUs = f.home.id === TEAM_ID;
  const us = isUs ? f.home_skins : f.away_skins;
  const them = isUs ? f.away_skins : f.home_skins;
  const opponent = opponentName(f);
  // A played game against a team that isn't currently in our division (a grading
  // foe, or a since-relegated side) gets a neutral "Not in Div" chip.
  const oppId = isUs ? f.away.id : f.home.id;
  const outOfDiv = f.played && oppId && !isDivisionTeam(oppId);

  let badge = "", cls = "result-card--upcoming";
  if (f.played) {
    if (us > them) { badge = `<span class="badge badge--win">Win</span>`; cls = "result-card--win"; }
    else if (us < them) { badge = `<span class="badge badge--loss">Loss</span>`; cls = "result-card--loss"; }
    else { badge = `<span class="badge badge--loss">Draw</span>`; cls = "result-card--loss"; }
  } else {
    badge = `<span class="badge badge--upcoming">Upcoming</span>`;
  }

  const scoreText = f.played
    ? `<span class="result-card__score--us">${us}</span><span class="result-card__score-sep">–</span>${them}`
    : `<small>vs</small>`;

  return `
    <div class="result-card ${cls}" data-fixture-id="${f.fixture_id ?? ""}">
      <div>
        <div class="result-card__date"><span class="result-card__day">${escapeHtml(f.date_str ?? "")}</span><span class="result-card__badges">${badge}${outOfDiv ? `<span class="badge badge--neutral">Not in Div</span>` : ""}</span></div>
        <div class="result-card__opp">${escapeHtml(opponent)}</div>
        <div class="result-card__meta">${escapeHtml(formatTime12(f.time))} · ${escapeHtml(f.court)}${f.is_grading ? " · Grading" : ""}</div>
      </div>
      <div class="result-card__score">${scoreText}</div>
    </div>`;
}

function sortedSquad(players) {
  // Core players first, stand-ins last — the split is roster-based (we know our own
  // squad), not games-based like other teams (sortedTeamSquad). Within each block,
  // order by most games played → least (ties: more runs, then name).
  return [...players].sort((a, b) => {
    const aStandin = jerseyNumber(a.name) == null;
    const bStandin = jerseyNumber(b.name) == null;
    if (aStandin !== bStandin) return aStandin ? 1 : -1;
    const ag = a.matches?.length ?? 0, bg = b.matches?.length ?? 0;
    if (ag !== bg) return bg - ag;
    const ar = a.totals?.runs ?? 0, br = b.totals?.runs ?? 0;
    if (ar !== br) return br - ar;
    return playerKey(a.name).localeCompare(playerKey(b.name));
  });
}

function playerCardHtml(p) {
  const t = p.totals;
  const shown = displayName(p.name);
  const initials = shown
    .split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const num = jerseyNumber(p.name);
  const isStandIn = num == null;
  const avatarText = isStandIn ? initials : String(num);
  return `
    <a class="player-card ${isStandIn ? "player-card--standin" : ""}" href="#player/${encodeURIComponent(playerKey(p.name))}">
      <div class="player-card__avatar">${escapeHtml(avatarText)}</div>
      <div class="player-card__name">${escapeHtml(shown)}${isStandIn ? ` <span class="player-card__tag">stand-in</span>` : ""}</div>
      <div class="player-card__stats">
        <div class="player-card__stat">
          <strong>${t.runs}</strong>
          <span>Runs</span>
        </div>
        <div class="player-card__stat">
          <strong>${t.wickets}</strong>
          <span>Wkts</span>
        </div>
        <div class="player-card__stat">
          <strong>${p.matches.length}</strong>
          <span>Games</span>
        </div>
      </div>
    </a>`;
}

// --- Player view -----------------------------------------------------

// Best single-game batting (most runs; ties → more recent) and bowling (most
// wickets, then fewest runs conceded; ties → more recent), for the hero chips.
function bestBattingMatch(matches) {
  let best = null;
  for (const m of matches || []) {
    const r = m.batting?.runs;
    if (r == null) continue;
    const fid = m.fixture_id ?? 0;
    if (!best || r > best.r || (r === best.r && fid > best.fid)) best = { r, fid, vs: m.vs };
  }
  return best;
}
function bestBowlingMatch(matches) {
  let best = null;
  for (const m of matches || []) {
    const w = m.bowling?.wickets;
    if (w == null) continue;
    const rc = m.bowling?.runs_conceded ?? 0;
    const fid = m.fixture_id ?? 0;
    if (!best || w > best.w || (w === best.w && rc < best.rc)
        || (w === best.w && rc === best.rc && fid > best.fid)) best = { w, rc, fid, vs: m.vs };
  }
  return best;
}

function renderPlayer(app, key, from) {
  let player = state.players.players.find(p => playerKey(p.name) === key);
  if (!player) player = state.players.players.find(p => firstNameKey(p.name) === firstNameKey(key));
  if (!player) {
    app.innerHTML = `<a class="back" href="#">‹ Back</a><div class="loading">Player not found.</div>`;
    return;
  }
  const t = player.totals;
  const shown = displayName(player.name);
  const initials = shown
    .split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const num = jerseyNumber(player.name);
  const avatarText = num != null ? String(num) : initials;

  const parents = parentsFor(player.name);
  const parentLabel = parents.length === 1 ? "Parent" : "Parents";
  const parentsLine = parents.length
    ? `<div class="detail-header__sub">${parentLabel}: ${escapeHtml(formatList(parents))}</div>`
    : "";

  const back = backTargetFor(from, "", "Back to Squad");

  // Personal-best chips for the hero box (each links to its game).
  const hsBest = bestBattingMatch(player.matches);
  const bbBest = bestBowlingMatch(player.matches);
  const cleanOpp = (vs) => escapeHtml((vs || "").replace(/^['"]+|['"]+$/g, "").trim());
  const hlChip = (fid, label, valueHtml, vs) =>
    `<a class="hl" href="#${escapeHtml(makeHash(`match/${fid}`, `player/${encodeURIComponent(key)}`))}">
        <span class="hl__chev" aria-hidden="true">›</span>
        <span class="hl__label">${label}</span>
        <span class="hl__val">${valueHtml}</span>
        <span class="hl__ctx">vs ${cleanOpp(vs)}</span>
      </a>`;
  const hlChips = [];
  if (hsBest) hlChips.push(hlChip(hsBest.fid, "High score batting",
    `${hsBest.r} <span class="hl__unit">runs</span>`, hsBest.vs));
  if (bbBest) hlChips.push(hlChip(bbBest.fid, "Best bowling",
    `${bbBest.w}/${bbBest.rc} <span class="hl__unit">(wickets / runs)</span>`, bbBest.vs));
  const highlightsHtml = hlChips.length ? `<div class="hl-row">${hlChips.join("")}</div>` : "";

  app.innerHTML = `
    <a class="back" href="#${escapeHtml(back.hash)}">‹ ${escapeHtml(back.label)}</a>
    <div class="detail-header detail-header--player">
      <div class="detail-header__main">
        <div class="detail-header__avatar">${escapeHtml(avatarText)}</div>
        <div>
          <div class="detail-header__name">${escapeHtml(shown)}</div>
          <div class="detail-header__sub">${player.matches.length} match${player.matches.length === 1 ? "" : "es"} played for ${TEAM_DISPLAY}</div>
          ${parentsLine}
        </div>
      </div>
      ${highlightsHtml}
    </div>

    <h3 class="subhead">Batting</h3>
    <div class="stat-grid">
      <div class="stat-grid__cell">
        <div class="stat-grid__num">${t.runs}</div>
        <div class="stat-grid__label">Total runs</div>
      </div>
      <div class="stat-grid__cell">
        <div class="stat-grid__num">${t.balls_faced}</div>
        <div class="stat-grid__label">Balls faced</div>
      </div>
      <div class="stat-grid__cell">
        <div class="stat-grid__num">${t.dismissals}</div>
        <div class="stat-grid__label">Outs</div>
      </div>
    </div>

    <h3 class="subhead">Bowling</h3>
    <div class="stat-grid">
      <div class="stat-grid__cell">
        <div class="stat-grid__num">${t.wickets}</div>
        <div class="stat-grid__label">Wickets</div>
      </div>
      <div class="stat-grid__cell">
        <div class="stat-grid__num">${t.overs_bowled}</div>
        <div class="stat-grid__label">Overs bowled</div>
      </div>
      <div class="stat-grid__cell">
        <div class="stat-grid__num">${t.runs_conceded}</div>
        <div class="stat-grid__label">Runs conceded</div>
      </div>
    </div>

    <h3 class="subhead">Match-by-match</h3>
    ${player.matches.length === 0
      ? `<div class="upcoming-shell">
      <p class="upcoming-shell__hint">Yet to play a game</p>
    </div>`
      : `<div class="table-card">
      <table class="table table--player-matches">
        <thead>
          <tr>
            <th class="date-col">Date</th>
            <th class="potd-h" aria-label="Player of the Day"></th>
            <th>Opponent</th>
            <th class="num-h" data-tip="Runs scored" aria-label="Runs scored">R</th>
            <th class="num-h" data-tip="Strike rate — runs ÷ balls × 100" aria-label="Strike rate, runs divided by balls times 100">SR</th>
            <th class="num-h" data-tip="Wickets taken" aria-label="Wickets taken">W</th>
            <th class="num-h" data-tip="Economy rate — runs ÷ overs" aria-label="Economy rate, runs divided by overs">ER</th>
          </tr>
        </thead>
        <tbody>
          ${[...player.matches]
            .sort((a, b) => (b.fixture_id ?? 0) - (a.fixture_id ?? 0))
            .map(m => {
              const dmy = formatDateDMY(m.date_str);
              const [dd, mm, yy] = dmy.split("/");
              // Year wrapped in a span so CSS can drop it on narrow phones.
              const dateCell = yy
                ? `${dd}/${mm}<span class="yr">/${yy}</span>`
                : escapeHtml(dmy);
              // Per-game key stats, mirroring the scorecard: R, SR (batting),
              // W, ER (bowling). SR/ER need balls/overs; "—" when not available.
              const bRuns = m.batting?.runs, bBalls = m.batting?.balls_faced;
              const wk = m.bowling?.wickets, rc = m.bowling?.runs_conceded, ov = m.bowling?.overs;
              const srCell = (bRuns != null && bBalls) ? strikeRate(bRuns, bBalls) : "—";
              const erCell = (rc != null && ov) ? economyRate(rc, ov) : "—";
              return `
              <tr class="player-row" data-fixture-id="${m.fixture_id}">
                <td class="date-col">${dateCell}</td>
                <td class="potd-cell">${isPotdForMatch(key, m) ? trophyIconHtml() : ""}</td>
                <td class="opp"><span class="opp-text">${escapeHtml(m.vs ?? "")}</span></td>
                <td class="num">${bRuns ?? "—"}</td>
                <td class="num">${srCell}</td>
                <td class="num">${wk ?? "—"}</td>
                <td class="num">${erCell}</td>
              </tr>`;
            }).join("")}
        </tbody>
      </table>
    </div>`}
  `;
  wirePlayerMatchClicks(app, key);
}

// --- Match view ------------------------------------------------------

async function renderMatch(app, fid, from) {
  const back = backTargetFor(from, "", "Back to Home");
  const backHtml = `<a class="back" href="#${escapeHtml(back.hash)}">‹ ${escapeHtml(back.label)}</a>`;
  app.innerHTML = `${backHtml}<div class="loading">Loading match…</div>`;
  const fixture = state.fixtures.fixtures.find(f => f.fixture_id === fid);
  let detail = state.matchCache.get(fid);
  if (!detail) {
    try {
      detail = await fetchJson(`data/matches/${fid}.json`);
      state.matchCache.set(fid, detail);
    } catch (err) {
      trackPageView(`match/${fid}`, gaFixtureOverride(fixture, "match"));
      const msg = navigator.onLine
        ? "Couldn't load match."
        : "Currently offline — Please check your connection";
      app.innerHTML = `${backHtml}<div class="loading">${msg}</div>`;
      return;
    }
  }

  // Guard: if someone navigates directly to #match/N while the scorecard is still
  // mid-game partial, bounce them back to the upcoming page (planned lineup view).
  // (Tracked after the guard — the upcoming page records the redirected view.)
  if (fixture && !fixture.scoresheet_complete) {
    window.location.hash = makeHash(`upcoming/${fid}`, from);
    return;
  }
  trackPageView(`match/${fid}`, gaFixtureOverride(fixture, "match"));

  const isUsHome = fixture && fixture.home.id === TEAM_ID;
  const summaries = detail.team_summaries || [];

  // The Summary list is in batting order. Find Firebirds entry by skins match.
  let fbSummary = null, oppSummary = null;
  if (fixture && summaries.length === 2) {
    const usSkins = isUsHome ? fixture.home_skins : fixture.away_skins;
    const themSkins = isUsHome ? fixture.away_skins : fixture.home_skins;
    fbSummary = summaries.find(s => s.total === usSkins) || summaries[0];
    oppSummary = summaries.find(s => s !== fbSummary) || summaries[1];
  } else {
    fbSummary = summaries[0];
    oppSummary = summaries[1];
  }

  const oppName = fixture ? opponentName(fixture) : (oppSummary?.display ?? "Opponent");
  // Opposition player rows link to their player page — but ONLY if the opponent
  // is currently in our division (a grading foe since-joined, e.g. Anderson
  // Aces, is clickable; Smashing Sataras / relegated Renegades are not).
  const oppTeamId = fixture
    ? (isUsHome ? fixture.away.id : fixture.home.id)
    : resolveTeamIdByName(oppName);
  const oppHref = isDivisionTeam(oppTeamId)
    ? ((name) => makeHash(`team/${oppTeamId}/player/${playerSlug(name)}`, `match/${fid}`))
    : null;
  const dt = fixture ? parseSpawtzDate(fixture.date_str, fixture.time) : null;
  const dateLabel = dt ? dt.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "long" }) : (fixture?.date_str ?? "");
  const iso = dt
    ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`
    : "";

  // Figure out which innings each summary corresponds to (for batting/bowling tables)
  const innings = detail.innings || [];
  let fbInningsIdx = -1;
  if (fixture && innings.length && summaries.length) {
    const usSkins = isUsHome ? fixture.home_skins : fixture.away_skins;
    fbInningsIdx = summaries.findIndex(s => s.total === usSkins);
  }
  const fbInnings = fbInningsIdx >= 0 ? innings[fbInningsIdx] : null;
  const oppInnings = fbInningsIdx >= 0 ? innings[1 - fbInningsIdx] : (innings[1] ?? null);

  const fbWon = fbSummary && oppSummary && fbSummary.total > oppSummary.total;
  const fbLost = fbSummary && oppSummary && fbSummary.total < oppSummary.total;
  const margin = fbSummary?.total != null && oppSummary?.total != null
    ? Math.abs(fbSummary.total - oppSummary.total)
    : null;
  const oppInitial = ((oppName || "").match(/[A-Za-z]/) || ["?"])[0].toUpperCase();
  const captain = state.schedule?.games?.[iso]?.captain || "";
  const oppOutOfDiv = oppTeamId && !isDivisionTeam(oppTeamId);

  // Perspective. When this scorecard is reached from ANOTHER division team's
  // pages (from=team/{id}), present it from THEIR side — their name first, their
  // Win/Loss verdict, their innings first — and hide our private planning
  // overlays (POTD, reserves/away, captain), which are just for us. From our own
  // contexts (home / our player / our upcoming) the `from` never starts with
  // "team/", so `flip` is false and the page renders exactly as before.
  const fromTeamId = (from || "").startsWith("team/") ? parseInt(from.split("/")[1], 10) : null;
  const flip = fromTeamId != null && fromTeamId !== TEAM_ID && isDivisionTeam(fromTeamId);
  const tableCaptain = flip ? "" : captain;

  const leadName  = flip ? oppName : TEAM_DISPLAY;
  const trailName = flip ? TEAM_DISPLAY : oppName;
  const leadSum   = flip ? oppSummary : fbSummary;
  const trailSum  = flip ? fbSummary  : oppSummary;
  const leadWon   = leadSum && trailSum && leadSum.total > trailSum.total;
  const leadLost  = leadSum && trailSum && leadSum.total < trailSum.total;
  const resultBadge = leadWon
    ? `<span class="badge badge--win">Win</span>`
    : leadLost ? `<span class="badge badge--loss">Loss</span>` : `<span class="badge badge--loss">Draw</span>`;
  const resultText = margin == null
    ? ""
    : margin === 0
      ? "Match drawn"
      : leadWon
        ? `${leadName} won by ${margin} run${margin === 1 ? "" : "s"}`
        : `${leadName} lost by ${margin} run${margin === 1 ? "" : "s"}`;

  // Each summary row carries its own crest; --lost marks the side that lost
  // (independent of display order, so the flip just reorders the two rows).
  const usRow = `
        <div class="match-summary__row ${fbLost ? "match-summary__row--lost" : ""}">
          <div class="match-summary__crest match-summary__crest--us" aria-hidden="true">
            <svg viewBox="0 0 64 64">
              <path d="M32 4 C 24 16, 18 22, 18 32 C 18 42, 24 50, 24 50 C 22 44, 22 38, 26 34 C 26 40, 28 46, 32 50 C 36 46, 38 40, 38 34 C 42 38, 42 44, 40 50 C 40 50, 46 42, 46 32 C 46 22, 40 16, 32 4 Z" fill="#0E353D"/>
            </svg>
          </div>
          <div class="match-summary__name">${escapeHtml(TEAM_DISPLAY)}</div>
          <div class="match-summary__score">${fbSummary?.total ?? "—"}</div>
        </div>`;
  const oppRow = `
        <div class="match-summary__row ${fbWon ? "match-summary__row--lost" : ""}">
          <div class="match-summary__crest" aria-hidden="true">${escapeHtml(oppInitial)}</div>
          <div class="match-summary__name">${escapeHtml(oppName)}</div>
          <div class="match-summary__score">${oppSummary?.total ?? "—"}</div>
        </div>`;

  // Our batting/bowling block — canonical names (NAME_OVERRIDES) + links to our
  // own player pages. Always rendered the same way regardless of perspective.
  const usTables = fbInnings ? `
      <h3 class="subhead">${escapeHtml(TEAM_DISPLAY)} batting</h3>
      ${battingTableHtml(fbInnings.batters, { linkPlayers: true, matchId: fid, captain: tableCaptain })}
      <h3 class="subhead">${escapeHtml(TEAM_DISPLAY)} bowling</h3>
      ${oppInnings ? bowlingTableHtml(oppInnings.bowlers, { linkPlayers: true, matchId: fid, captain: tableCaptain }) : "<p>No bowling data.</p>"}
    ` : "";
  // Opponent block — verbatim names; rows link to their pages only if they're a
  // division team; a single "Team not in division" note sits above their two
  // tables when they're not.
  const oppNote = oppOutOfDiv ? `<p class="match-note">Team not in division</p>` : "";
  const oppInner = `
      ${oppNote}
      ${oppInnings ? `<h3 class="subhead">${escapeHtml(oppName)} batting</h3>${battingTableHtml(oppInnings.batters, { opponent: true, linkHref: oppHref })}` : ""}
      ${fbInnings ? `<h3 class="subhead">${escapeHtml(oppName)} bowling</h3>${bowlingTableHtml(fbInnings.bowlers, { opponent: true, linkHref: oppHref })}` : ""}
  `;
  // Out-of-division opponents render in the greyed "inactive" treatment; an
  // in-division opponent's tables stay in the normal palette (and stay
  // clickable). Only wrap when inactive so in-division layout is untouched.
  const oppTables = (oppInnings || fbInnings)
    ? (oppOutOfDiv ? `<div class="match-inactive">${oppInner}</div>` : oppInner)
    : "";

  app.innerHTML = `
    ${backHtml}
    <div class="detail-header">
      <div class="detail-header__main">
        <div class="detail-header__avatar">vs</div>
        <div>
          <div class="detail-header__name">${escapeHtml(leadName)} vs ${escapeHtml(trailName)} ${resultBadge}</div>
          <div class="detail-header__sub">${escapeHtml(dateLabel)} · ${escapeHtml(formatTime12(fixture?.time ?? ""))} · ${escapeHtml(fixture?.court ?? "")}${fixture?.is_grading ? " · Grading" : ""}</div>
          ${(!flip && captain) ? `<div class="detail-header__sub"><strong>Captain:</strong> ${escapeHtml(resolveFullName(captain))}</div>` : ""}
        </div>
      </div>
    </div>

    <div class="match-top">
      <div class="match-summary">
        ${flip ? oppRow : usRow}
        <div class="match-summary__divider"><span class="match-summary__vs">vs</span></div>
        ${flip ? usRow : oppRow}
        ${resultText ? `<div class="match-summary__result">${escapeHtml(resultText)}</div>` : ""}
      </div>

      ${flip ? "" : potdCardHtml(iso, fbInnings, oppInnings, fid)}
    </div>

    ${flip ? "" : lineupCardHtml(iso)}

    ${flip ? `${oppTables}${usTables}` : `${usTables}${oppTables}`}
  `;

  wireRowNavigation(app);
}

function wireRowNavigation(scope) {
  scope.querySelectorAll("[data-target-hash]").forEach(el => {
    const target = el.getAttribute("data-target-hash");
    if (!target) return;
    el.addEventListener("click", () => { window.location.hash = target; });
  });
}

function formatTime12(t) {
  // '13:00' → '1:00pm'. Defensive: returns the raw string on parse failure.
  if (!t) return "";
  const [hRaw, mRaw] = String(t).split(":");
  const h = Number(hRaw);
  if (Number.isNaN(h)) return t;
  const m = Number.isNaN(Number(mRaw)) ? 0 : Number(mRaw);
  const period = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${period}`;
}

function formatDateDMY(spawtzDate) {
  // 'Saturday 25 Apr 2026' → '25/04/26'. Returns the original string on
  // parse failure so we never blank a cell silently.
  const parts = (spawtzDate || "").split(/\s+/);
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  for (let i = 0; i < parts.length; i++) {
    if (/^\d+$/.test(parts[i]) && i + 2 < parts.length) {
      const mi = months.findIndex(m => parts[i+1].slice(0,3).toLowerCase() === m);
      if (mi < 0) return spawtzDate || "";
      return `${parts[i].padStart(2,"0")}/${String(mi+1).padStart(2,"0")}/${parts[i+2].slice(-2)}`;
    }
  }
  return spawtzDate || "";
}

function trophyIconHtml() {
  // Flat single-colour trophy. `currentColor` lets CSS control the fill.
  return `<svg class="trophy" viewBox="0 0 24 24" fill="currentColor" aria-label="Player of the Day" role="img">
    <path d="M7 4h10v2h3v3a4 4 0 0 1-4 4h-.4a5 5 0 0 1-3.6 3.93V19h3v2H9v-2h3v-2.07A5 5 0 0 1 8.4 13H8a4 4 0 0 1-4-4V6h3V4Zm0 4H6v1a2 2 0 0 0 2 2V8Zm10 0v3a2 2 0 0 0 2-2V8h-2Z"/>
  </svg>`;
}

function isPotdForMatch(playerKeyVal, matchRecord) {
  // Map the match's date_str (e.g. 'Saturday 25 Apr 2026') to ISO, look up
  // schedule.json for that date's POTD, compare canonical first-name keys.
  const dateStr = matchRecord?.date_str || "";
  const parts = dateStr.split(/\s+/);
  const numIdx = parts.findIndex(p => /^\d+$/.test(p));
  if (numIdx < 0 || parts.length < numIdx + 3) return false;
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const mi = months.findIndex(m => parts[numIdx + 1].slice(0, 3).toLowerCase() === m);
  if (mi < 0) return false;
  const iso = `${parts[numIdx + 2]}-${String(mi + 1).padStart(2, "0")}-${parts[numIdx].padStart(2, "0")}`;
  const potd = state.schedule?.games?.[iso]?.potd;
  return !!potd && playerKey(potd) === playerKeyVal;
}

function potdCardHtml(iso, fbInnings, oppInnings, matchId) {
  const potd = state.schedule?.games?.[iso]?.potd;
  if (!potd) return "";
  const key = playerKey(potd);
  const batter = (fbInnings?.batters || []).find(b => playerKey(b.name) === key);
  const bowler = (oppInnings?.bowlers || []).find(b => playerKey(b.name) === key);
  // Prefer the scoresheet's full name (matches the player profile records);
  // fall back to roster lookup if neither innings has stats for them.
  const fullName = batter?.name || bowler?.name || resolveFullName(potd);
  const shown = displayName(fullName);
  const initials = shown
    .split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const href = makeHash(
    `player/${encodeURIComponent(key)}`,
    matchId != null ? `match/${matchId}` : ""
  );
  const stat = (val, label) => `
    <div class="potd-card__stat">
      <strong>${val != null && val !== "" ? escapeHtml(String(val)) : "—"}</strong>
      <span>${label}</span>
    </div>`;
  return `
    <a class="potd-card" href="#${escapeHtml(href)}">
      <div class="potd-card__badge">Player of the Day</div>
      <div class="potd-card__body">
        <div class="potd-card__avatar">${escapeHtml(initials)}</div>
        <div class="potd-card__info">
          <div class="potd-card__name">${escapeHtml(shown)}</div>
          <div class="potd-card__group">
            <div class="potd-card__group-label">Batting</div>
            <div class="potd-card__stats">
              ${stat(batter?.runs, "Runs")}
              ${stat(batter?.balls_faced, "Balls")}
              ${stat(batter?.dismissals, "Outs")}
            </div>
          </div>
          <div class="potd-card__group">
            <div class="potd-card__group-label">Bowling</div>
            <div class="potd-card__stats">
              ${stat(bowler?.overs, "Overs")}
              ${stat(bowler?.wickets, "Wkts")}
              ${stat(bowler?.runs_conceded, "Conceded")}
            </div>
          </div>
        </div>
      </div>
    </a>`;
}

// Strike rate = runs / balls * 100 (rounded). Indoor scores can be negative
// (a wicket is -5), so SR/ER can be too — shown as-is.
const strikeRate = (r, b) => (b ? String(Math.round((r / b) * 100)) : "—");

function battingTableHtml(batters, opts = {}) {
  if (!batters || !batters.length) return "<p>No batting data.</p>";
  const { linkPlayers = false, matchId = null, captain = "", opponent = false } = opts;
  const captainKey = captain ? playerKey(captain) : "";

  let body = "";
  for (let i = 0; i < batters.length; i += 2) {
    const pair = batters.slice(i, i + 2);
    const pairRuns = pair.reduce((sum, b) => sum + (b.runs || 0), 0);
    const pairNum = Math.floor(i / 2) + 1;
    const ordinal = ["1st", "2nd", "3rd", "4th", "5th"][pairNum - 1] || `${pairNum}th`;
    body += `
      <tr class="partnership-header">
        <td colspan="6">
          <div class="partnership-inner">
            <span class="partnership-tag">${escapeHtml(ordinal)} partnership</span>
            <span class="partnership-runs">
              <span class="partnership-runs__num">${pairRuns}</span>
              <span class="partnership-runs__label">${pairRuns === 1 ? "run" : "runs"}</span>
            </span>
          </div>
        </td>
      </tr>`;
    for (const b of pair) {
      const isCap = captainKey && playerKey(b.name) === captainKey;
      const rowAttrs = opts.linkHref ? linkRowAttrs(opts.linkHref(b.name)) : rowLinkAttrs(b.name, linkPlayers, matchId);
      body += `
        <tr ${rowAttrs}>
          <td>${escapeHtml(displayName(b.name, { opponent }) + (isCap ? " (c)" : ""))}</td>
          <td class="num">${b.runs}</td>
          <td class="num">${b.balls_faced}</td>
          <td class="num dk-only">${(b.fours ?? 0) + (b.fives ?? 0)}</td>
          <td class="num dk-only">${b.sixes ?? 0}</td>
          <td class="num">${strikeRate(b.runs, b.balls_faced)}</td>
        </tr>`;
    }
  }

  return `
    <div class="table-card">
      <table class="table table--partnerships table--scorecard">
        <thead><tr>
          <th>Batters (in order)</th>
          <th class="num-h" data-tip="Runs scored" aria-label="Runs scored">R</th>
          <th class="num-h" data-tip="Balls faced" aria-label="Balls faced">B</th>
          <th class="num-h dk-only" data-tip="balls scoring 4 or 5" aria-label="Balls scoring 4 or 5">4+</th>
          <th class="num-h dk-only" data-tip="balls scoring 6 or more" aria-label="Balls scoring 6 or more">6+</th>
          <th class="num-h" data-tip="Strike rate — runs ÷ balls × 100" aria-label="Strike rate, runs divided by balls times 100">SR</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

// Economy rate = runs conceded / overs.
const economyRate = (r, o) => (o ? (r / o).toFixed(1) : "—");

function bowlingTableHtml(bowlers, opts = {}) {
  if (!bowlers || !bowlers.length) return "<p>No bowling data.</p>";
  const { linkPlayers = false, matchId = null, captain = "", opponent = false } = opts;
  const captainKey = captain ? playerKey(captain) : "";
  return `
    <div class="table-card">
      <table class="table table--scorecard">
        <thead><tr>
          <th>Bowlers (in order)</th>
          <th class="num-h" data-tip="Wickets taken" aria-label="Wickets taken">W</th>
          <th class="num-h" data-tip="Runs conceded" aria-label="Runs conceded">R</th>
          <th class="num-h dk-only" data-tip="Wides" aria-label="Wides">WD</th>
          <th class="num-h dk-only" data-tip="No-balls" aria-label="No-balls">NB</th>
          <th class="num-h" data-tip="Economy rate — runs ÷ overs" aria-label="Economy rate, runs divided by overs">ER</th>
        </tr></thead>
        <tbody>
          ${bowlers.map(b => {
            const isCap = captainKey && playerKey(b.name) === captainKey;
            const rowAttrs = opts.linkHref ? linkRowAttrs(opts.linkHref(b.name)) : rowLinkAttrs(b.name, linkPlayers, matchId);
            return `
            <tr ${rowAttrs}>
              <td>${escapeHtml(displayName(b.name, { opponent }) + (isCap ? " (c)" : ""))}</td>
              <td class="num">${b.wickets}</td>
              <td class="num">${b.runs_conceded}</td>
              <td class="num dk-only">${b.wides ?? 0}</td>
              <td class="num dk-only">${b.no_balls ?? 0}</td>
              <td class="num">${economyRate(b.runs_conceded, b.overs)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;
}

function rowLinkAttrs(name, linkable, matchId, fromKind = "match") {
  if (!linkable) return "";
  const target = makeHash(
    `player/${encodeURIComponent(playerKey(name))}`,
    matchId != null ? `${fromKind}/${matchId}` : ""
  );
  return `class="player-row" data-target-hash="${escapeHtml(target)}"`;
}

// --- Helpers ---------------------------------------------------------

function opponentName(f) {
  if (!f) return "";
  return f.home.id === TEAM_ID ? f.away.display : f.home.display;
}

// levenshtein + coreKey mirror scrape.py's _levenshtein / core_key — keep the
// two in sync. coreKey folds a misspelled CORE name onto its canonical key;
// stand-ins are never fuzzy-matched.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a || !b) return a.length + b.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Same rule as scrape.py core_key: same first letter, unambiguous best match,
// edit distance <=1 for core names of 4 chars or fewer, <=2 for longer.
// Returns the canonical core key, or null for anything that isn't a close
// match to a core name (i.e. a stand-in).
function coreKey(first) {
  if (ROSTER_KEYS.has(first)) return first;
  let best = null, bestD = 99;
  for (const core of ROSTER_KEYS) {
    if (first[0] !== core[0] || Math.abs(core.length - first.length) > 2) continue;
    const d = levenshtein(first, core);
    const thr = core.length <= 4 ? 1 : 2;
    if (d <= thr) {
      if (d < bestD) { best = core; bestD = d; }
      else if (d === bestD) { best = null; }
    }
  }
  return best;
}

function surnameClose(a, b) {
  if (a === b) return true;
  return levenshtein(a, b) <= (Math.min(a.length, b.length) <= 4 ? 1 : 2);
}

// First-name-only key (core misspelling folded; surname ignored). Used to
// resolve a bare first-name reference from the plan ("Vivaan", "Jack") back to
// a player record, which may be keyed by full name.
function firstNameKey(name) {
  if (!name) return "";
  let first = name.split(/\s+/)[0].toLowerCase();
  first = PLAYER_ALIASES[first] ?? first;
  return coreKey(first) ?? first;
}

// Identity key using the FULL name. Mirror of scrape.py player_key: folds onto
// a core player only when the first name matches AND the surname matches (or
// none is given); otherwise keys by full name, so a stand-in never merges into
// a core player and two same-first-name stand-ins stay separate.
function playerKey(name) {
  if (!name) return "";
  const tokens = name.toLowerCase().split(/\s+/).filter(t => t && t !== "unknown");
  if (!tokens.length) return "";
  const first = PLAYER_ALIASES[tokens[0]] ?? tokens[0];
  const surname = tokens.slice(1).join(" ");
  const core = coreKey(first);
  if (core !== null && (!surname || surnameClose(surname, ROSTER_SURNAMES[core]))) return core;
  return surname ? `${first} ${surname}` : first;
}

function parseSpawtzDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  // 'Saturday 25 Apr 2026' or 'Sat 25 Apr 2026'
  const parts = dateStr.trim().split(/\s+/);
  const num = parts.findIndex(p => /^\d+$/.test(p));
  if (num < 0 || parts.length < num + 3) return null;
  const [d, mon, yr] = parts.slice(num, num + 3);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mi = months.findIndex(m => m.toLowerCase() === mon.slice(0, 3).toLowerCase());
  if (mi < 0) return null;
  const [hh, mm] = timeStr.split(":").map(Number);
  return new Date(Number(yr), mi, Number(d), hh || 0, mm || 0);
}

// Games are exactly one hour long (indoor cricket runs strictly to time), so
// from the start time we know the live window [start, start + 1h].
const GAME_DURATION_MS = 60 * 60 * 1000;

// Which part of the one-hour window a game is in, from its start datetime.
// Single source of truth for the hero label, pill text, and pill styling.
function gamePhase(dt) {
  if (!dt) return "upcoming";
  const now = Date.now();
  const start = dt.getTime();
  if (now >= start + gameDurationMs()) return "finished";
  if (now >= start) return "live";
  return "upcoming";
}

function countdownText(dt) {
  const phase = gamePhase(dt);
  if (phase === "finished") return "Completed";
  if (phase === "live") return "In progress";
  // Upcoming — relative calendar day (browser-local TZ; the dashboard is viewed in NZ).
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const gameDay = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const diffDays = Math.round((gameDay - today) / (1000 * 60 * 60 * 24));
  if (diffDays > 1) return `In ${diffDays} days`;
  if (diffDays === 1) return "Tomorrow";
  const timeStr = dt.toLocaleTimeString("en-NZ", {
    hour: "numeric", minute: "2-digit", hour12: true,
  });
  return `Today, ${timeStr}`;
}

// Hero eyebrow label tracks the same window: Next Game → Live Game → Played
// Game. (The pill, via countdownText, shows the countdown, then "In progress",
// then "Completed".)
function heroLabel(dt) {
  return { upcoming: "Next Game", live: "Live Game", finished: "Played Game" }[gamePhase(dt)];
}

function relativeTime(then) {
  const diff = Math.max(0, Math.floor((Date.now() - then.getTime()) / 1000));
  if (diff < 300) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wireResultClicks(scope) {
  scope.querySelectorAll(".result-card[data-fixture-id]").forEach(el => {
    const fid = el.getAttribute("data-fixture-id");
    if (!fid) return;
    el.addEventListener("click", () => {
      // Coming from home → no `from` so the match's back button defaults
      // to "Back to Home".
      window.location.hash = `match/${fid}`;
    });
  });
}
function wirePlayerClicks(_scope) {
  // Player cards are anchor tags — native navigation works.
}
function wirePlayerMatchClicks(scope, fromPlayerKey) {
  scope.querySelectorAll(".player-row[data-fixture-id]").forEach(el => {
    const fid = el.getAttribute("data-fixture-id");
    if (!fid) return;
    el.addEventListener("click", () => {
      // From a player page → thread `from=player/X` so the match's back
      // button reads "Back to {first name}".
      window.location.hash = makeHash(`match/${fid}`, `player/${fromPlayerKey}`);
    });
  });
}

// --- Install chip ---------------------------------------------------

function installChipHtml() {
  if (isStandalonePWA) return ""; // Already installed — never offer again.
  // Initial visibility:
  //   - iOS: show right away; click opens the instructions overlay.
  //   - Anything else: render hidden, the beforeinstallprompt listener
  //     unhides it once the browser confirms install eligibility.
  const showNow = isIOSDevice || deferredInstallPrompt !== null;
  // Label tracks form factor: phones/tablets get "Add to Home Screen",
  // desktops (Mac/Windows/Linux) get "Add to Desktop".
  const isMobileDevice =
    isIOSDevice || /Android/i.test(navigator.userAgent);
  const chipLabel = isMobileDevice ? "Add to Home Screen" : "Add to Desktop";
  return `
    <button class="install-chip" type="button"${showNow ? "" : " hidden"}>
      <span class="install-chip__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4" y="3" width="16" height="18" rx="2.5"/>
          <path d="M12 8v7"/>
          <path d="M9 12l3 3 3-3"/>
        </svg>
      </span>
      <span class="install-chip__text">${chipLabel}</span>
    </button>`;
}

function wireInstallChip(scope) {
  const btn = scope.querySelector(".install-chip");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    trackEvent("install_chip_click", {
      platform: deferredInstallPrompt ? "native_prompt" : "ios_instructions",
    });
    if (deferredInstallPrompt) {
      // Android / desktop Chrome / Edge path.
      const ev = deferredInstallPrompt;
      deferredInstallPrompt = null;
      try {
        ev.prompt();
        const { outcome } = await ev.userChoice;
        trackEvent("install_prompt_result", { outcome });
        if (outcome === "accepted") {
          btn.hidden = true;
        }
      } catch (err) {
        console.error("install prompt:", err);
      }
      return;
    }
    if (isIOSDevice) {
      showIOSInstallOverlay();
    }
  });
}

function showIOSInstallOverlay() {
  // Already open? Don't stack.
  if (document.querySelector(".install-overlay")) return;
  const atTop = iosShareLocation === "top";
  const overlay = document.createElement("div");
  overlay.className = "install-overlay";
  overlay.innerHTML = `
    <div class="install-overlay__backdrop"></div>
    <div class="install-overlay__card" role="dialog" aria-modal="true" aria-labelledby="install-overlay-title">
      <button class="install-overlay__close" type="button" aria-label="Close">×</button>
      <h3 class="install-overlay__title" id="install-overlay-title">Add to Home Screen</h3>
      <p class="install-overlay__sub">Opens like an app, faster load, works offline.</p>
      <ol class="install-overlay__steps">
        <li>
          <span class="install-overlay__num">1</span>
          <span>Tap
            <span class="install-overlay__inline-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3v13"/>
                <path d="M8 7l4-4 4 4"/>
                <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>
              </svg>
            </span>
            <strong>Share</strong> at <strong>${atTop ? "top" : "bottom"}</strong> of screen.
          </span>
        </li>
        <li>
          <span class="install-overlay__num">2</span>
          <span>Tap
            <span class="install-overlay__inline-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/>
                <path d="M12 8v8"/>
                <path d="M8 12h8"/>
              </svg>
            </span>
            <strong>Add to Home Screen</strong>.
          </span>
        </li>
      </ol>
      <p class="install-overlay__note">
        <span class="install-overlay__note-line">
          Can't see
          <span class="install-overlay__inline-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/>
              <path d="M12 8v8"/>
              <path d="M8 12h8"/>
            </svg>
          </span>
          <strong>Add to Home Screen</strong>?
        </span>
        <span class="install-overlay__note-line">
          Tap <strong>View more</strong>
          <span class="install-overlay__inline-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 9l6 6 6-6"/>
            </svg>
          </span>
        </span>
      </p>
    </div>
  `;
  document.body.appendChild(overlay);
  // Freeze the app-shell scroll pane while the overlay is open. It's an inner
  // scroller (not the document body), so a plain overflow:hidden reliably
  // freezes it on iOS — no position:fixed body-pin needed. Restore the prior
  // overflow and scroll position on close so the user lands where they were.
  const pane = document.querySelector(".scroll-pane");
  const lockedScrollTop = pane ? pane.scrollTop : 0;
  const prevOverflow = pane ? pane.style.overflow : "";
  if (pane) pane.style.overflow = "hidden";
  const close = () => {
    overlay.remove();
    if (pane) {
      pane.style.overflow = prevOverflow;
      pane.scrollTop = lockedScrollTop;
    }
  };
  overlay.querySelector(".install-overlay__close").addEventListener("click", close);
  overlay.querySelector(".install-overlay__backdrop").addEventListener("click", close);
  // Esc dismisses too — friendly for desktop testers.
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", onEsc);
    }
  });
}

// --- Push notifications ---------------------------------------------

function pushSupported() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    WEBHOOK_URL.indexOf("REPLACE_ME") === -1
  );
}

function notifyChipHtml() {
  if (!pushSupported()) return "";
  // Pick a best-guess initial state synchronously so the chip renders
  // in the right shape on first paint instead of starting "loading" and
  // flipping a moment later. refreshChipState() reconciles asynchronously.
  //   denied → permission is revoked, no need to guess.
  //   default → permission never asked, so no active subscription.
  //   granted → fall back to last-known cached state ("on"/"off").
  let initialState = "loading";
  let initialText = "Notifications off";
  try {
    if (Notification.permission === "denied") {
      initialState = "denied";
      initialText = "Notifications blocked";
    } else if (Notification.permission === "default") {
      initialState = "off";
    } else {
      const cached = localStorage.getItem(CACHE_KEYS.notifyState);
      if (cached === "on") {
        initialState = "on";
        initialText = "Notifications on";
      } else if (cached === "off") {
        initialState = "off";
      }
    }
  } catch {}
  // Two SVGs live in the chip and CSS shows the one matching data-state.
  // currentColor on both so they pick up whatever text colour the chip has.
  return `
    <button class="notify-chip" data-state="${initialState}" type="button" aria-live="polite">
      <span class="notify-chip__icon" aria-hidden="true">
        <svg class="notify-chip__bell notify-chip__bell--on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
        </svg>
        <svg class="notify-chip__bell notify-chip__bell--off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          <path d="M18.63 13A17.89 17.89 0 0 1 18 8"/>
          <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/>
          <path d="M18 8a6 6 0 0 0-9.33-5"/>
          <line x1="1" y1="1" x2="23" y2="23"/>
        </svg>
      </span>
      <span class="notify-chip__text">${initialText}</span>
    </button>`;
}

function wireNotifyChip(scope) {
  const btn = scope.querySelector(".notify-chip");
  if (!btn) return;

  // Render current state, then re-render after any click. Uses
  // navigator.serviceWorker.ready to make sure the SW is active before
  // touching PushManager.
  async function refreshChipState() {
    if (Notification.permission === "denied") {
      setChip(btn, "denied", "Notifications blocked");
      try { localStorage.setItem(CACHE_KEYS.notifyState, "denied"); } catch {}
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const resolved = sub ? "on" : "off";
      setChip(btn, resolved, sub ? "Notifications on" : "Notifications off");
      try { localStorage.setItem(CACHE_KEYS.notifyState, resolved); } catch {}
    } catch (err) {
      console.error("notify-chip state:", err);
      setChip(btn, "off", "Notifications off");
      try { localStorage.setItem(CACHE_KEYS.notifyState, "off"); } catch {}
    }
  }

  let inFlight = false;
  btn.addEventListener("click", async () => {
    const state = btn.getAttribute("data-state");
    if (state === "denied" || state === "loading" || inFlight) return;
    inFlight = true;

    // Flip the chip's label immediately so the click feels instant. The
    // network work happens in the background; refreshChipState at the end
    // reconciles if anything failed (denied permission, network error).
    setChip(btn, state === "on" ? "off" : "on",
      state === "on" ? "Notifications off" : "Notifications on");

    try {
      if (state === "on") {
        await unsubscribeFromPush();
        trackEvent("notifications_off");
      } else {
        await subscribeToPush();
        trackEvent("notifications_on");
      }
    } catch (err) {
      console.error("notify-chip click:", err);
      // Silent for "permission not granted" — the user just dismissed or
      // blocked the browser prompt. refreshChipState will show the right
      // state. Alert for anything else (e.g. webhook unreachable).
      if (!String(err.message || err).toLowerCase().includes("permission")) {
        alert(`Couldn't update notifications: ${err.message || err}`);
      } else {
        trackEvent("notifications_denied");
      }
    } finally {
      inFlight = false;
      await refreshChipState();
    }
  });

  refreshChipState();
}

function setChip(btn, state, text) {
  btn.setAttribute("data-state", state);
  btn.disabled = (state === "denied" || state === "loading");
  const textEl = btn.querySelector(".notify-chip__text");
  if (textEl) textEl.textContent = text;
}

async function subscribeToPush() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Permission not granted");
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  await postWebhook({
    action: "subscribe",
    subscription: sub.toJSON(),
    user_agent: navigator.userAgent,
    device_id: getDeviceId(),
  });
}

async function unsubscribeFromPush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  try {
    await postWebhook({
      action: "unsubscribe",
      endpoint,
      device_id: getDeviceId(),
    });
  } catch (err) {
    // Server-side cleanup is best-effort — the local subscription is
    // already gone, which is the user-visible state that matters.
    console.warn("unsubscribe webhook failed:", err);
  }
}

async function postWebhook(payload) {
  // Use text/plain content-type so the request stays "simple" by CORS
  // rules and skips the OPTIONS preflight that Apps Script can't handle.
  // Server-side still parses e.postData.contents as JSON.
  const r = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Webhook ${r.status}`);
  const json = await r.json();
  if (json.error) throw new Error(json.error);
  return json;
}

// --- Activations -----------------------------------------------------

const ACTIVATION_THROTTLE_MS = 60 * 60 * 1000; // 1 hour (one Session Log row per rolling 1h window per device)

function getDeviceId() {
  let id = null;
  try { id = localStorage.getItem("firebirds.device_id"); } catch {}
  if (id) return id;
  id = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { localStorage.setItem("firebirds.device_id", id); } catch {}
  return id;
}

// Build a clean, human-readable snapshot of the current device + the moment
// of this session, for the append-only "Session Log" tab. Best-effort by
// nature: UA strings are coarse (iOS only ever says "iPhone", never a model)
// and a client POST exposes no IP, so there is no location/geo here — that's
// a deliberate limit, not a gap. Browser / OS / device-type are parsed here
// so the sheet stays readable; the raw UA is logged too as a fallback.
function describeDevice() {
  const ua = navigator.userAgent || "";
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  let m;

  // OS — check iOS before Mac (iPadOS Safari masquerades as macOS).
  let os = "Unknown";
  if (/iPhone|iPad|iPod/.test(ua)) {
    m = ua.match(/OS (\d+)[._](\d+)/);
    os = "iOS" + (m ? ` ${m[1]}.${m[2]}` : "");
  } else if (/Android/.test(ua)) {
    m = ua.match(/Android (\d+(?:\.\d+)?)/);
    os = "Android" + (m ? ` ${m[1]}` : "");
  } else if (/Mac OS X/.test(ua)) {
    if (navigator.maxTouchPoints > 1) {
      os = "iPadOS"; // touch-capable "Mac" is really an iPad
    } else {
      m = ua.match(/Mac OS X (\d+)[._](\d+)/);
      os = "macOS" + (m ? ` ${m[1]}.${m[2]}` : "");
    }
  } else if (/Windows NT/.test(ua)) {
    const winMap = { "10.0": "10/11", "6.3": "8.1", "6.2": "8", "6.1": "7" };
    m = ua.match(/Windows NT (\d+\.\d+)/);
    os = "Windows" + (m && winMap[m[1]] ? ` ${winMap[m[1]]}` : "");
  } else if (/CrOS/.test(ua)) {
    os = "ChromeOS";
  } else if (/Linux/.test(ua)) {
    os = "Linux";
  }

  // Browser — order matters (Edge/Opera embed "Chrome"; Chrome embeds
  // "Safari"; iOS Chrome/Firefox use CriOS/FxiOS).
  let browser = "Unknown";
  if (/Edg(?:e|A|iOS)?\//.test(ua)) {
    m = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/); browser = "Edge" + (m ? ` ${m[1]}` : "");
  } else if (/SamsungBrowser\//.test(ua)) {
    m = ua.match(/SamsungBrowser\/(\d+)/); browser = "Samsung Internet" + (m ? ` ${m[1]}` : "");
  } else if (/OPR\/|Opera/.test(ua)) {
    m = ua.match(/(?:OPR|Opera)\/(\d+)/); browser = "Opera" + (m ? ` ${m[1]}` : "");
  } else if (/CriOS\//.test(ua)) {
    m = ua.match(/CriOS\/(\d+)/); browser = "Chrome" + (m ? ` ${m[1]}` : "");
  } else if (/FxiOS\/|Firefox\//.test(ua)) {
    m = ua.match(/(?:FxiOS|Firefox)\/(\d+)/); browser = "Firefox" + (m ? ` ${m[1]}` : "");
  } else if (/Chrome\//.test(ua)) {
    m = ua.match(/Chrome\/(\d+)/); browser = "Chrome" + (m ? ` ${m[1]}` : "");
  } else if (/Version\//.test(ua) && /Safari\//.test(ua)) {
    m = ua.match(/Version\/(\d+)/); browser = "Safari" + (m ? ` ${m[1]}` : "");
  }

  // Device type.
  let deviceType = "desktop";
  if (/iPad/.test(ua) || os === "iPadOS" || /Tablet/.test(ua) ||
      (/Android/.test(ua) && !/Mobile/.test(ua))) {
    deviceType = "tablet";
  } else if (/Mobi|iPhone|iPod/.test(ua) ||
      (/Android/.test(ua) && /Mobile/.test(ua))) {
    deviceType = "mobile";
  }

  let tz = "";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch {}
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return {
    // Device-local wall clock — this is what "time of day for this device"
    // means, independent of the server's timezone. Sortable string plus
    // split-out hour/weekday so time-of-day and day-of-week pivots need no
    // parsing in the sheet.
    device_local_time:
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    device_local_hour: now.getHours(),
    device_weekday: weekdays[now.getDay()],
    tz,
    tz_offset_min: -now.getTimezoneOffset(), // minutes east of UTC
    browser,
    os,
    device_type: deviceType,
    screen: `${screen.width}x${screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio || 1,
    language: navigator.language || "",
    online: navigator.onLine,
    page: location.hash || "(home)",
  };
}

async function recordActivation() {
  if (WEBHOOK_URL.indexOf("REPLACE_ME") !== -1) return;
  let last = 0;
  try { last = parseInt(localStorage.getItem("firebirds.last_activation_at") || "0", 10); } catch {}
  if (Date.now() - last < ACTIVATION_THROTTLE_MS) return;
  try { localStorage.setItem("firebirds.last_activation_at", String(Date.now())); } catch {}
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "record_activation",
        device_id: getDeviceId(),
        user_agent: navigator.userAgent,
        // True if the user is currently using the installed PWA (home
        // screen launch) rather than visiting the site in a browser tab.
        // Apps Script writes this as Yes/No in the Activations sheet.
        installed: isStandalonePWA,
        // Comprehensive per-session detail for the append-only Session Log
        // tab. Extra keys are harmlessly ignored by older webhook deploys
        // (the Activations rollup keeps working) until the updated Apps
        // Script is live.
        ...describeDevice(),
      }),
    });
  } catch (err) {
    console.warn("record_activation failed:", err);
  }
}

function urlBase64ToUint8Array(base64) {
  // VAPID public keys are URL-safe base64 without padding; turn that into
  // the Uint8Array PushManager.subscribe wants.
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
