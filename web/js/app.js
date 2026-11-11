import { api } from "./api.js";
import {
  ago,
  dayKey,
  dayLabel,
  esc,
  formatMoney,
  formatTime,
  formatWhen,
  localInputValue,
  parseStake,
  safeColor,
  signedMoney,
  stakeSentence,
} from "./format.js";

const app = document.querySelector("#app");
const modal = document.querySelector("#modal");

const state = {
  ready: false,
  people: [],
  currencies: [],
  sports: [],
  me: "",
  authMode: "sign-in",
  sport: localStorage.getItem("marker.sport") || "nfl",
  currency: localStorage.getItem("marker.currency") || "USD",
  route: "board",
  board: null,
  events: [],
  eventsSync: null,
  eventsWarning: "",
  history: [],
  records: null,
  busy: false,
  token: 0,
};

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const control = target.closest("[data-action]");
  if (!control) return;
  onAction(control, event);
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.form) return;
  event.preventDefault();
  onSubmit(form);
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (["history-a", "history-b", "history-currency", "history-voids"].includes(target.id)) {
    paintHistory();
    return;
  }
  const form = target.closest("form");
  if (!form) return;
  if (target.name === "makerId") syncTaker(form);
  if (target.name === "currencyMore" && target.value) markCurrency(form, target.value);
  if (form.dataset.form === "custom-event" && target.name === "sport") toggleLeague(form);
  if (form.dataset.form === "past-bet") labelOutcomes(form);
  if (form.dataset.form === "bet") sideReadout(form);
  updatePreview(form);
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.id === "event-search") {
    paintEvents();
    return;
  }
  if (target.id === "history-q") {
    paintHistory();
    return;
  }
  const form = target.closest("form");
  if (form) updatePreview(form);
});

modal.addEventListener("click", (event) => {
  if (event.target === modal) modal.close();
});

window.addEventListener("hashchange", () => {
  if (state.ready) render();
});

boot();

async function boot() {
  try {
    localStorage.removeItem("marker.me");
    const session = await api.get("/api/session");
    state.authMode = session.needsAccount ? "create" : "sign-in";
    if (!session.person) {
      state.ready = true;
      renderAuth();
      return;
    }
    state.me = session.person.id;
    await reloadMeta();
    if (!state.sports.some((sport) => sport.id === state.sport)) state.sport = "nfl";
    state.ready = true;
    if (!location.hash || location.hash === "#/" || location.hash === "#/welcome") {
      history.replaceState(null, "", "#/board");
    }
    render();
  } catch (error) {
    app.innerHTML = `<section class="welcome"><p class="kicker">Marker</p><h1>The book isn't reachable.</h1><p class="lede">${esc(error.message)}. Start it with <code>py -m marker</code> and refresh this page.</p></section>`;
  }
}

async function reloadMeta() {
  const meta = await api.get("/api/meta");
  state.people = meta.people;
  state.currencies = meta.currencies;
  state.sports = meta.sports;
  if (!state.people.some((person) => person.id === state.me)) state.me = "";
  if (!state.currencies.some((currency) => currency.code === state.currency)) {
    state.currency = "USD";
  }
}

function render() {
  if (!state.me) {
    renderAuth();
    return;
  }
  const raw = location.hash.replace(/^#\/?/, "");
  const name = raw.split("?")[0].split("/")[0] || "board";
  state.route = ["board", "events", "history", "records", "people"].includes(name) ? name : "board";
  document.body.classList.add("has-nav");
  app.innerHTML = shell(pageSkeleton(state.route));
  hydrate(state.route);
}

function renderAuth() {
  state.route = "auth";
  document.body.classList.remove("has-nav");
  app.innerHTML = authHtml();
  app.querySelector("input[name=name]")?.focus();
}

async function hydrate(route) {
  const token = ++state.token;
  try {
    if (route === "board") await loadBoard(token, false);
    else if (route === "events") await loadEvents(token, false);
    else if (route === "history") await loadHistory(token);
    else if (route === "records") await loadRecords(token);
    else if (route === "people") await loadPeople(token);
  } catch (error) {
    if (token !== state.token) return;
    if (error.status === 401) {
      state.me = "";
      renderAuth();
      return;
    }
    const panel = document.querySelector("#panel");
    if (panel) panel.innerHTML = emptyBlock("Couldn't load this", error.message, true);
  }
}

function authHtml() {
  const creating = state.authMode === "create";
  return `
    <section class="welcome">
      <p class="kicker">A private book</p>
      <h1>${creating ? "Make your account." : "Sign in."}</h1>
      <p class="lede">${creating
        ? "Use the name your friends already call you. You propose a bet, and they accept or decline on their own phone."
        : "Sign in as yourself. A bet stays a proposal until the other person accepts it."}</p>
      <form data-form="${creating ? "register" : "login"}" autocomplete="off">
        <label>Name
          <input name="name" maxlength="40" autocomplete="username" required>
        </label>
        <label>Password
          <input name="password" type="password" minlength="8" maxlength="128" autocomplete="${creating ? "new-password" : "current-password"}" required>
        </label>
        <p class="form-error" hidden></p>
        <button class="btn primary" type="submit">${creating ? "Create account" : "Sign in"}</button>
      </form>
      <button type="button" class="btn ghost" data-action="auth-mode" data-mode="${creating ? "sign-in" : "create"}">${creating ? "I already have an account" : "Create an account"}</button>
      <p class="fine">Marker records the bet. It does not hold or move the money. The phone book, for iPhone and Android, is at <a href="/phone/">/phone/</a>.</p>
    </section>`;
}

function mePerson() {
  return state.people.find((person) => person.id === state.me) || null;
}

function shell(content) {
  const links = [
    ["board", "Board"],
    ["events", "Events"],
    ["history", "History"],
    ["records", "Records"],
  ];
  const nav = links.map(([id, label]) => `
    <a href="#/${id}" ${state.route === id ? 'aria-current="page"' : ""}>${label}</a>`).join("");
  const me = mePerson();
  return `
    <div class="shell">
      <header class="top">
        <a class="brand" href="#/board"><span class="mark" aria-hidden="true"></span><span>Marker</span></a>
        <nav class="nav">${nav}</nav>
        <div class="who">
          ${me ? `<span class="who-cell who-name"><span class="swatch" style="background:${safeColor(me.color)}"></span>${esc(me.name)}</span>` : ""}
          <button type="button" class="btn ghost small" data-action="sign-out">Sign out</button>
          <a class="crew-link ${state.route === "people" ? "on" : ""}" href="#/people">Crew</a>
        </div>
      </header>
      <main>${content}</main>
      <p class="fineprint">Marker records the bet. It does not hold or move the money. Schedules come from the public ESPN scoreboard.</p>
    </div>`;
}

function pageSkeleton(route) {
  if (route === "board") {
    return `<section class="page">
      <div class="page-head">
        <div><p class="kicker">The book</p><h1>Open action</h1></div>
        <button type="button" class="btn ghost" data-action="reload-board">Refresh results</button>
      </div>
      <div id="panel"><p class="muted">Opening the book…</p></div>
    </section>`;
  }
  if (route === "events") {
    return `<section class="page">
      <div class="page-head">
        <div><p class="kicker">Slate</p><h1>What's on</h1></div>
        <div class="row-actions">
          <button type="button" class="btn ghost" data-action="custom-event">Custom event</button>
          <button type="button" class="btn ghost" data-action="reload-events">Refresh</button>
        </div>
      </div>
      <div class="pills">${state.sports.map((sport) => `
        <button type="button" class="pill ${sport.id === state.sport ? "on" : ""}" data-action="pick-sport" data-sport="${esc(sport.id)}">${esc(sport.label)}</button>`).join("")}</div>
      <div class="toolbar">
        <input id="event-search" placeholder="Search teams, fighters, races" aria-label="Search events">
        <p class="muted" id="sync-line"></p>
      </div>
      <div id="panel"><p class="muted">Pulling the slate…</p></div>
    </section>`;
  }
  if (route === "history") {
    const query = currentQuery();
    return `<section class="page">
      <div class="page-head">
        <div><p class="kicker">Ledger</p><h1>Every bet</h1></div>
        <div class="row-actions">
          <button type="button" class="btn ghost" data-action="past-bet">Log a settled bet</button>
          <a class="btn ghost" href="/api/export.csv">Download CSV</a>
        </div>
      </div>
      <div class="filters">
        <input id="history-q" placeholder="Search events or picks" aria-label="Search history">
        <select id="history-a" aria-label="First person">${personFilterOptions(query.get("a") || "")}</select>
        <select id="history-b" aria-label="Second person">${personFilterOptions(query.get("b") || "", "and anyone")}</select>
        <select id="history-currency" aria-label="Currency">
          <option value="">Any currency</option>
          ${state.currencies.map((currency) => `<option value="${esc(currency.code)}">${esc(currency.code === "GOLD" ? "Gold bars" : currency.code)}</option>`).join("")}
        </select>
        <label class="check"><input id="history-voids" type="checkbox"> Show voids and declined</label>
      </div>
      <div id="panel"><p class="muted">Reading the ledger…</p></div>
    </section>`;
  }
  if (route === "records") {
    return `<section class="page">
      <div class="page-head"><div><p class="kicker">The table</p><h1>Records</h1></div></div>
      <div id="panel"><p class="muted">Adding up the book…</p></div>
    </section>`;
  }
  return `<section class="page">
    <div class="page-head"><div><p class="kicker">Table</p><h1>Crew and currencies</h1></div></div>
    <div id="panel"><p class="muted">Loading…</p></div>
  </section>`;
}

function personFilterOptions(selected, blank = "Anyone") {
  const options = [`<option value="">${esc(blank)}</option>`];
  for (const person of state.people) {
    options.push(`<option value="${esc(person.id)}" ${person.id === selected ? "selected" : ""}>${esc(person.name)}</option>`);
  }
  return options.join("");
}

async function loadBoard(token, refresh) {
  const data = await api.get(`/api/board${refresh ? "?refresh=1" : ""}`);
  if (token !== state.token) return;
  state.board = data;
  paintBoard();
}

function paintBoard() {
  const panel = document.querySelector("#panel");
  if (!panel || !state.board) return;
  const data = state.board;
  const me = data.me;
  const proposed = (data.bets || []).filter((bet) => bet.status === "proposed");
  const openBets = [...(data.bets || [])].filter((bet) => bet.status === "open").sort((a, b) => {
    const rank = (bet) => (bet.eventStatus === "final" || bet.eventStatus === "cancelled" || bet.suggestion?.result ? 0 : 1);
    const diff = rank(a) - rank(b);
    if (diff) return diff;
    return (a.eventStart || "").localeCompare(b.eventStart || "");
  });
  const incoming = proposed.filter((bet) => bet.taker.id === state.me);
  const outgoing = proposed.filter((bet) => bet.maker.id === state.me);
  const watching = proposed.filter((bet) => bet.maker.id !== state.me && bet.taker.id !== state.me);
  const ready = openBets.filter((bet) => bet.eventStatus === "final" || bet.eventStatus === "cancelled" || bet.suggestion?.result);
  const waiting = openBets.filter((bet) => !ready.includes(bet));
  const warnings = (data.warnings || []).map((warning) => `<p class="banner warn">${esc(warning)}</p>`).join("");
  const owes = (data.owes || []).map((owe) => `<li>${esc(oweLine(owe))}</li>`).join("");
  const any = proposed.length || openBets.length;
  panel.innerHTML = `
    ${warnings}
    ${me ? tiles(me, openBets) : ""}
    ${owes ? `<section class="block"><h2>Who owes whom</h2><ul class="owes">${owes}</ul></section>` : ""}
    ${incoming.length ? `<section class="block"><h2>For you to answer</h2><div class="stack">${incoming.map((bet) => betCard(bet, false)).join("")}</div></section>` : ""}
    ${outgoing.length ? `<section class="block"><h2>Waiting on them</h2><div class="stack">${outgoing.map((bet) => betCard(bet, false)).join("")}</div></section>` : ""}
    ${watching.length ? `<section class="block"><h2>Waiting on an answer</h2><div class="stack">${watching.map((bet) => betCard(bet, false)).join("")}</div></section>` : ""}
    ${ready.length ? `<section class="block"><h2>Ready to settle</h2><div class="stack">${ready.map((bet) => betCard(bet, true)).join("")}</div></section>` : ""}
    ${waiting.length ? `<section class="block"><h2>Still open</h2><div class="stack">${waiting.map((bet) => betCard(bet, false)).join("")}</div></section>` : ""}
    ${any ? "" : `<div class="empty"><h3>The book is clear</h3><p>Propose a bet from the slate. It lands here, and it counts once your friend accepts.</p><a class="btn" href="#/events">Find a game</a></div>`}
  `;
}

function tiles(me, bets) {
  const record = `${me.wins}–${me.losses}${me.pushes ? `–${me.pushes}` : ""}`;
  const pct = me.winPct == null ? "No decisions yet" : `${Math.round(me.winPct * 100)}% win`;
  const streak = me.streak ? `${me.streak.startsWith("W") ? "Won" : "Lost"} ${me.streak.slice(1)} in a row` : "No streak";
  const nets = me.nets.length
    ? me.nets.map((net) => signedMoney(net.amount, net.currency)).join(" · ")
    : "Even";
  const exposure = exposureFor(bets, state.me);
  const onTable = exposure.length
    ? exposure.map((item) => formatMoney(item.amount, item.currency)).join(" · ")
    : "Nothing open";
  return `<div class="tiles">
    <article class="tile"><p class="label">Your record</p><p class="value">${esc(record)}</p><p class="sub">${esc(pct)} · ${esc(streak)}</p></article>
    <article class="tile"><p class="label">Your net</p><p class="value">${esc(nets)}</p><p class="sub">Settled bets only</p></article>
    <article class="tile"><p class="label">On the table</p><p class="value">${esc(onTable)}</p><p class="sub">${bets.filter((bet) => bet.maker.id === state.me || bet.taker.id === state.me).length} open for you</p></article>
  </div>`;
}

function exposureFor(bets, personId) {
  const totals = new Map();
  for (const bet of bets) {
    let stake = null;
    if (bet.maker.id === personId) stake = Number(bet.makerStake);
    else if (bet.taker.id === personId) stake = Number(bet.takerStake);
    if (stake == null) continue;
    const current = totals.get(bet.currency.code) || { currency: bet.currency, amount: 0 };
    const factor = 10 ** (bet.currency.decimals ?? 2);
    current.amount = Math.round((current.amount + stake) * factor) / factor;
    totals.set(bet.currency.code, current);
  }
  return [...totals.values()];
}

function oweLine(owe) {
  const money = formatMoney(owe.amount, owe.currency);
  if (owe.from.id === state.me) return `You owe ${owe.to.name} ${money}`;
  if (owe.to.id === state.me) return `${owe.from.name} owes you ${money}`;
  return `${owe.from.name} owes ${owe.to.name} ${money}`;
}

function betCard(bet, showSettle) {
  const mine = bet.maker.id === state.me || bet.taker.id === state.me;
  const suggestion = bet.suggestion
    ? `<div class="suggestion"><span>${esc(bet.suggestion.label)}</span>${mine && bet.suggestion.result ? `<button type="button" class="btn small" data-action="settle" data-id="${esc(bet.id)}" data-result="${esc(bet.suggestion.result)}">Use this</button>` : ""}</div>`
    : "";
  return `<article class="bet-card ${mine ? "mine" : ""}">
    <header class="spread">
      <div>
        <p class="kicker">${esc(bet.eventLeague || sportLabel(bet.eventSport))} · ${esc(formatWhen(bet.eventStart))}</p>
        <h3>${esc(bet.eventTitle)}</h3>
      </div>
      <div class="tags">${mine ? '<span class="tag open">You</span>' : ""}${statusTag(bet)}</div>
    </header>
    <div class="sides">
      ${sideRow(bet.maker, bet.makerPick, bet.makerStake, bet.currency, bet.status === "settled" && bet.winnerId === bet.maker.id)}
      ${sideRow(bet.taker, bet.takerPick, bet.takerStake, bet.currency, bet.status === "settled" && bet.winnerId === bet.taker.id)}
    </div>
    <p class="stake-line">${esc(stakeSentence(bet))}</p>
    ${bet.note ? `<p class="note">${esc(bet.note)}</p>` : ""}
    ${suggestion}
    ${betActions(bet, showSettle)}
  </article>`;
}

function betActions(bet, showSettle) {
  const mine = bet.maker.id === state.me || bet.taker.id === state.me;
  if (bet.status === "proposed" && bet.taker.id === state.me) {
    return `<div class="actions">
      <button type="button" class="btn small" data-action="accept" data-id="${esc(bet.id)}">Accept</button>
      <button type="button" class="btn small danger" data-action="decline" data-id="${esc(bet.id)}">Decline</button>
    </div>`;
  }
  if (bet.status === "proposed" && bet.maker.id === state.me) {
    return `<div class="actions">
      <button type="button" class="btn small ghost" data-action="edit-bet" data-id="${esc(bet.id)}">Edit</button>
      <button type="button" class="btn small danger" data-action="withdraw" data-id="${esc(bet.id)}">Withdraw</button>
    </div>`;
  }
  if (!mine) {
    if (bet.status === "open" || bet.status === "proposed") return "";
    return `<div class="actions"><span class="muted">${esc(formatWhen(bet.settledAt || bet.createdAt))}</span></div>`;
  }
  if (bet.status === "open") return settleActions(bet, showSettle);
  if (bet.status === "settled" || bet.status === "push" || bet.status === "void") return historyActions(bet);
  return `<div class="actions"><span class="muted">${esc(formatWhen(bet.settledAt || bet.createdAt))}</span></div>`;
}

function sideRow(person, pick, stake, currency, won) {
  return `<div class="side ${won ? "won" : ""}">
    <span class="swatch" style="background:${safeColor(person.color)}"></span>
    <div class="side-copy"><strong>${esc(person.name)}</strong><span>${esc(pick)}</span></div>
    <div class="side-stake">${esc(formatMoney(stake, currency))}</div>
  </div>`;
}

function statusTag(bet) {
  if (bet.status === "proposed") {
    if (bet.taker.id === state.me) return '<span class="tag live">Needs you</span>';
    if (bet.maker.id === state.me) return '<span class="tag open">Waiting</span>';
    return '<span class="tag open">Proposed</span>';
  }
  if (bet.status === "declined") return '<span class="tag void">Declined</span>';
  if (bet.status === "withdrawn") return '<span class="tag void">Withdrawn</span>';
  if (bet.status === "push") return '<span class="tag push">Push</span>';
  if (bet.status === "void") return '<span class="tag void">Void</span>';
  if (bet.status === "settled") {
    const winner = bet.winnerId === bet.maker.id ? bet.maker : bet.taker;
    return `<span class="tag win">${esc(winner.name)} won</span>`;
  }
  const live = bet.eventStatus === "live";
  const final = bet.eventStatus === "final";
  const label = live ? "Live" : final ? "Final" : bet.eventStatus === "cancelled" ? "Cancelled" : "Open";
  const cls = live ? "live" : final ? "final" : "open";
  return `<span class="tag ${cls}">${label}</span>`;
}

function settleActions(bet, open) {
  const buttons = `
    <button type="button" class="btn small" data-action="settle" data-id="${esc(bet.id)}" data-result="maker">${esc(bet.maker.name)} won</button>
    <button type="button" class="btn small" data-action="settle" data-id="${esc(bet.id)}" data-result="taker">${esc(bet.taker.name)} won</button>
    <button type="button" class="btn small ghost" data-action="settle" data-id="${esc(bet.id)}" data-result="push">Push</button>
    <button type="button" class="btn small ghost" data-action="edit-note" data-id="${esc(bet.id)}">Note</button>
    <button type="button" class="btn small danger" data-action="settle" data-id="${esc(bet.id)}" data-result="void">Void</button>`;
  if (open) return `<div class="actions">${buttons}</div>`;
  return `<details class="settle"><summary>Settle</summary><div class="actions">${buttons}</div></details>`;
}

function historyActions(bet) {
  return `<div class="actions">
    <button type="button" class="btn small ghost" data-action="reopen" data-id="${esc(bet.id)}">Reopen</button>
    <button type="button" class="btn small ghost" data-action="edit-note" data-id="${esc(bet.id)}">Note</button>
    <span class="muted">${esc(formatWhen(bet.settledAt || bet.createdAt))}</span>
  </div>`;
}

async function loadEvents(token, refresh) {
  const panel = document.querySelector("#panel");
  if (panel) panel.innerHTML = `<p class="muted">Pulling ${esc(sportLabel(state.sport))}…</p>`;
  const data = await api.get(`/api/events?sport=${encodeURIComponent(state.sport)}${refresh ? "&refresh=1" : ""}`);
  if (token !== state.token) return;
  state.events = data.events || [];
  state.eventsSync = data.sync;
  state.eventsWarning = data.warning || "";
  const line = document.querySelector("#sync-line");
  if (line) {
    line.textContent = state.eventsWarning
      ? state.eventsWarning
      : data.sync?.fetchedAt
        ? `Updated ${ago(data.sync.fetchedAt)} · ${state.events.length} on the slate`
        : "";
  }
  paintEvents();
}

function paintEvents() {
  const panel = document.querySelector("#panel");
  if (!panel || state.route !== "events") return;
  const events = visibleEvents();
  if (!events.length) {
    panel.innerHTML = `<div class="empty"><h3>Nothing on this slate</h3><p>${esc(state.eventsWarning || "The season may be quiet, or the feed didn't answer. A custom event still works.")}</p><button type="button" class="btn" data-action="custom-event">Write a custom event</button></div>`;
    return;
  }
  const days = groupEvents(events);
  panel.innerHTML = days.map((day) => {
    const body = state.sport === "ufc"
      ? ufcBlocks(day.events).map((block) => `
          <section class="card-block">
            <h3>${esc(block.card)}</h3>
            <div class="stack">${block.events.map(eventRow).join("")}</div>
          </section>`).join("")
      : `<div class="stack">${day.events.map(eventRow).join("")}</div>`;
    return `<section class="day"><h2>${esc(day.label)}</h2>${body}</section>`;
  }).join("");
}

function visibleEvents() {
  const query = (document.querySelector("#event-search")?.value || "").trim().toLowerCase();
  if (!query) return state.events;
  return state.events.filter((event) => {
    const blob = [event.title, event.subtitle, event.league, event.detail, ...(event.competitors || []).map((c) => c.name)].join(" ").toLowerCase();
    return blob.includes(query);
  });
}

function groupEvents(events) {
  const days = [];
  const byDay = new Map();
  for (const event of [...events].sort((a, b) => a.startTime.localeCompare(b.startTime))) {
    const key = dayKey(event.startTime);
    if (!byDay.has(key)) {
      const bucket = { key, label: dayLabel(event.startTime), events: [] };
      byDay.set(key, bucket);
      days.push(bucket);
    }
    byDay.get(key).events.push(event);
  }
  return days;
}

function ufcBlocks(events) {
  const blocks = [];
  const map = new Map();
  for (const event of [...events].sort((a, b) => b.startTime.localeCompare(a.startTime))) {
    const card = (event.subtitle || event.league || "UFC").split(" · ")[0];
    if (!map.has(card)) {
      const block = { card, events: [] };
      map.set(card, block);
      blocks.push(block);
    }
    map.get(card).events.push(event);
  }
  return blocks;
}

function eventRow(event) {
  const score = scoreText(event);
  const meta = [event.subtitle, event.detail].filter(Boolean).join(" · ");
  const count = (event.competitors || []).length;
  const extra = count > 4 ? `${count} to choose from` : "";
  return `<article class="event-row">
    <div class="event-time">${event.status === "live" ? '<span class="dot"></span>' : ""}${esc(formatTime(event.startTime))}</div>
    <div class="event-main">
      <div class="spread"><h3>${esc(event.title)}</h3>${score ? `<span class="score">${esc(score)}</span>` : ""}</div>
      <p class="muted">${esc([meta, extra].filter(Boolean).join(" · "))}</p>
    </div>
    <button type="button" class="btn small" data-action="open-bet" data-id="${esc(event.id)}">Bet</button>
  </article>`;
}

function scoreText(event) {
  if (!["live", "final"].includes(event.status) || (event.competitors || []).length !== 2) return "";
  const [a, b] = event.competitors;
  if (!a.score && !b.score) return "";
  return `${a.score}–${b.score}`;
}

async function loadHistory(token) {
  const data = await api.get("/api/bets?status=closed");
  if (token !== state.token) return;
  state.history = data.bets || [];
  paintHistory();
}

function paintHistory() {
  const panel = document.querySelector("#panel");
  if (!panel || state.route !== "history") return;
  const bets = filteredHistory();
  if (!state.history.length) {
    panel.innerHTML = `<div class="empty"><h3>No settled bets yet</h3><p>Settle an open bet, or log one you already shook on.</p><button type="button" class="btn" data-action="past-bet">Log a settled bet</button></div>`;
    return;
  }
  if (!bets.length) {
    panel.innerHTML = `<div class="empty"><h3>Nothing matches</h3><p>Try another person, currency, or search.</p></div>`;
    return;
  }
  panel.innerHTML = `<div class="stack">${bets.map((bet) => betCard(bet, false)).join("")}</div>`;
}

function filteredHistory() {
  const query = (document.querySelector("#history-q")?.value || "").trim().toLowerCase();
  const a = document.querySelector("#history-a")?.value || "";
  const b = document.querySelector("#history-b")?.value || "";
  const currency = document.querySelector("#history-currency")?.value || "";
  const voids = document.querySelector("#history-voids")?.checked;
  return state.history.filter((bet) => {
    if (!voids && (bet.status === "void" || bet.status === "declined" || bet.status === "withdrawn")) return false;
    if (currency && bet.currency.code !== currency) return false;
    const ids = [bet.maker.id, bet.taker.id];
    if (a && b && !((ids.includes(a) && ids.includes(b)))) return false;
    if (a && !b && !ids.includes(a)) return false;
    if (b && !a && !ids.includes(b)) return false;
    if (!query) return true;
    const blob = [bet.eventTitle, bet.makerPick, bet.takerPick, bet.maker.name, bet.taker.name, bet.note, bet.eventLeague].join(" ").toLowerCase();
    return blob.includes(query);
  });
}

async function loadRecords(token) {
  const data = await api.get("/api/records");
  if (token !== state.token) return;
  state.records = data;
  paintRecords();
}

function paintRecords() {
  const panel = document.querySelector("#panel");
  if (!panel || !state.records) return;
  const rows = state.records.leaderboard || [];
  const currencies = [];
  const seen = new Set();
  for (const row of rows) {
    for (const net of row.nets) {
      if (!seen.has(net.currency.code)) {
        seen.add(net.currency.code);
        currencies.push(net.currency);
      }
    }
  }
  const head = currencies.map((currency) => `<th>${esc(currency.code === "GOLD" ? "Gold" : currency.code)}</th>`).join("");
  const body = rows.map((row) => {
    const money = currencies.map((currency) => {
      const net = row.nets.find((item) => item.currency.code === currency.code);
      return `<td>${net ? esc(signedMoney(net.amount, net.currency)) : "—"}</td>`;
    }).join("");
    const pct = row.winPct == null ? "—" : `${Math.round(row.winPct * 100)}%`;
    return `<tr class="${row.person.id === state.me ? "me" : ""}">
      <td><span class="who-cell"><span class="swatch" style="background:${safeColor(row.person.color)}"></span>${esc(row.person.name)}</span></td>
      <td>${row.wins}–${row.losses}–${row.pushes}</td>
      <td>${pct}</td>
      <td>${esc(row.streak || "—")}</td>
      ${money}
    </tr>`;
  }).join("");
  const owes = (state.records.owes || []).map((owe) => `<li>${esc(`${owe.from.name} owes ${owe.to.name} ${formatMoney(owe.amount, owe.currency)}`)}</li>`).join("");
  const pairs = (state.records.pairs || []).map((pair) => {
    const nets = pair.nets.map((net) => `<li>${esc(netPhrase(pair, net))}</li>`).join("");
    const pushes = pair.pushes ? `<p class="muted">${pair.pushes} push${pair.pushes === 1 ? "" : "es"}</p>` : "";
    return `<article class="pair-card">
      <div class="spread"><h3>${esc(series(pair))}</h3><a href="#/history?a=${esc(pair.a.id)}&b=${esc(pair.b.id)}">See the bets</a></div>
      ${pushes}
      ${nets ? `<ul class="plain">${nets}</ul>` : `<p class="muted">No money has changed hands.</p>`}
    </article>`;
  }).join("");
  const any = rows.some((row) => row.wins || row.losses || row.pushes);
  panel.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Person</th><th>W–L–P</th><th>Win %</th><th>Streak</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <section class="block"><h2>Who owes whom</h2>${owes ? `<ul class="owes">${owes}</ul>` : `<p class="muted">${any ? "Everyone is settled up." : "Settle a bet and the tab shows up here."}</p>`}</section>
    <section class="block"><h2>Head to head</h2>${pairs ? `<div class="pair-grid">${pairs}</div>` : `<p class="muted">No one has a series yet.</p>`}</section>
  `;
}

function series(pair) {
  if (pair.aWins === pair.bWins) return `Split ${pair.aWins}–${pair.bWins}`;
  if (pair.aWins > pair.bWins) return `${pair.a.name} leads ${pair.aWins}–${pair.bWins}`;
  return `${pair.b.name} leads ${pair.bWins}–${pair.aWins}`;
}

function netPhrase(pair, net) {
  if (net.amount > 0) return `${pair.a.name} is up ${formatMoney(net.amount, net.currency)}`;
  if (net.amount < 0) return `${pair.b.name} is up ${formatMoney(Math.abs(net.amount), net.currency)}`;
  return "";
}

async function loadPeople(token) {
  await reloadMeta();
  if (token !== state.token) return;
  paintPeople();
}

function paintPeople() {
  const panel = document.querySelector("#panel");
  if (!panel) return;
  const me = state.people.find((person) => person.id === state.me);
  const others = state.people.filter((person) => person.id !== state.me);
  const you = me ? `
    <form class="person-row" data-form="rename-person" data-id="${esc(me.id)}" autocomplete="off">
      <span class="swatch" style="background:${safeColor(me.color)}"></span>
      <label class="grow">Your name
        <input name="name" maxlength="40" value="${esc(me.name)}">
      </label>
      <button class="btn small" type="submit">Save</button>
      ${me.betCount ? `<span class="muted">${me.betCount} bet${me.betCount === 1 ? "" : "s"}</span>` : `<button type="button" class="btn small danger" data-action="delete-person" data-id="${esc(me.id)}" data-name="${esc(me.name)}">Remove</button>`}
    </form>` : "";
  const crew = others.map((person) => `
    <div class="person-row">
      <span class="swatch" style="background:${safeColor(person.color)}"></span>
      <div class="grow"><strong>${esc(person.name)}</strong></div>
      <span class="muted">${person.betCount ? `${person.betCount} bet${person.betCount === 1 ? "" : "s"}` : "No bets yet"}</span>
    </div>`).join("");
  const currencies = state.currencies.map((currency) => `
    <li>
      <strong>${esc(currency.code === "GOLD" ? "Gold bars" : currency.name)}</strong>
      <span class="muted">${esc(currency.code)} · ${esc(currency.symbol)}</span>
      ${currency.kind === "custom" ? `<button type="button" class="btn small danger" data-action="delete-currency" data-code="${esc(currency.code)}">Remove</button>` : ""}
    </li>`).join("");
  panel.innerHTML = `
    <section class="block">
      <h2>Crew</h2>
      <p class="muted">Each friend creates their own account from the sign-in screen. You can rename yourself.</p>
      <div class="stack">${you}${crew || '<p class="muted">No one else has signed up yet.</p>'}</div>
    </section>
    <section class="block">
      <h2>Currencies</h2>
      <p class="muted">Dollars, dong, and gold bars are built in. Add anything else you settle in. A bet uses one currency.</p>
      <ul class="currency-list">${currencies}</ul>
      <form class="currency-form" data-form="add-currency" autocomplete="off">
        <label>Code <input name="code" maxlength="8" placeholder="BEER" required></label>
        <label>Name <input name="name" maxlength="40" placeholder="Beer" required></label>
        <label>Symbol <input name="symbol" maxlength="8" placeholder="🍺" required></label>
        <label>Decimals <input name="decimals" inputmode="numeric" value="0" required></label>
        <button class="btn" type="submit">Add currency</button>
      </form>
    </section>
  `;
}

function onAction(control, event) {
  const action = control.dataset.action;
  if (action === "auth-mode") {
    state.authMode = control.dataset.mode === "create" ? "create" : "sign-in";
    renderAuth();
    return;
  }
  if (action === "sign-out") {
    run(async () => {
      await api.post("/api/logout", {});
      state.me = "";
      state.board = null;
      state.history = [];
      renderAuth();
      toast("Signed out.");
    });
    return;
  }
  if (action === "close-modal") {
    modal.close();
    return;
  }
  if (action === "retry") {
    hydrate(state.route);
    return;
  }
  if (action === "pick-sport") {
    state.sport = control.dataset.sport;
    localStorage.setItem("marker.sport", state.sport);
    document.querySelectorAll("[data-action=pick-sport]").forEach((pill) => {
      pill.classList.toggle("on", pill.dataset.sport === state.sport);
    });
    const search = document.querySelector("#event-search");
    if (search) search.value = "";
    loadEvents(++state.token, false).catch((error) => {
      if (error.status === 401) {
        state.me = "";
        renderAuth();
        return;
      }
      const panel = document.querySelector("#panel");
      if (panel) panel.innerHTML = emptyBlock("Couldn't load this slate", error.message, true);
    });
    return;
  }
  if (action === "pick-currency") {
    const form = control.closest("form");
    if (form) {
      markCurrency(form, control.dataset.code);
      updatePreview(form);
    }
    return;
  }
  if (action === "pick-side") {
    pickSide(control);
    return;
  }
  if (action === "bet-mode") {
    setBetMode(control.closest("form"), control.dataset.mode);
    return;
  }
  if (action === "same-stake") {
    const form = control.closest("form");
    if (form?.makerStake && form.takerStake) {
      form.takerStake.value = form.makerStake.value;
      updatePreview(form);
    }
    return;
  }
  if (action === "reload-board") {
    run(async () => {
      const panel = document.querySelector("#panel");
      if (panel) panel.innerHTML = `<p class="muted">Checking results…</p>`;
      await loadBoard(++state.token, true);
      if (state.board?.warnings?.length) toast(state.board.warnings[0]);
      else toast("Results refreshed.");
    });
    return;
  }
  if (action === "reload-events") {
    run(async () => {
      await loadEvents(++state.token, true);
      toast(state.eventsWarning || "Slate refreshed.");
    });
    return;
  }
  if (action === "open-bet") {
    openBet(control.dataset.id);
    return;
  }
  if (action === "edit-bet") {
    openEdit(control.dataset.id);
    return;
  }
  if (action === "edit-note") {
    openNote(control.dataset.id);
    return;
  }
  if (action === "accept" || action === "decline" || action === "withdraw") {
    answerBet(control.dataset.id, action);
    return;
  }
  if (action === "custom-event") {
    openCustom();
    return;
  }
  if (action === "past-bet") {
    openPast();
    return;
  }
  if (action === "settle") {
    event.preventDefault();
    settleBet(control.dataset.id, control.dataset.result);
    return;
  }
  if (action === "reopen") {
    reopenBet(control.dataset.id);
    return;
  }
  if (action === "delete-person") {
    deletePerson(control.dataset.id, control.dataset.name);
    return;
  }
  if (action === "delete-currency") {
    deleteCurrency(control.dataset.code);
  }
}

async function onSubmit(form) {
  const kind = form.dataset.form;
  if (kind === "login" || kind === "register") {
    await run(async () => {
      const name = String(new FormData(form).get("name") || "").trim();
      const password = String(new FormData(form).get("password") || "");
      if (password.length < 8) {
        formError(form, "Use at least 8 characters.");
        return;
      }
      const data = await api.post(kind === "register" ? "/api/register" : "/api/login", { name, password });
      state.me = data.person.id;
      await reloadMeta();
      toast(kind === "register" ? `Welcome, ${data.person.name}.` : `Signed in as ${data.person.name}.`);
      if (!location.hash || location.hash === "#/" || location.hash === "#/welcome") {
        history.replaceState(null, "", "#/board");
      }
      render();
    });
    return;
  }
  if (kind === "rename-person") {
    await run(async () => {
      await api.patch(`/api/people/${encodeURIComponent(form.dataset.id)}`, { name: form.name.value });
      await reloadMeta();
      toast("Name saved.");
      render();
    });
    return;
  }
  if (kind === "add-currency") {
    await run(async () => {
      await api.post("/api/currencies", {
        code: form.code.value,
        name: form.name.value,
        symbol: form.symbol.value,
        decimals: Number(form.decimals.value),
      });
      await reloadMeta();
      toast("Currency added.");
      render();
    });
    return;
  }
  if (kind === "bet") {
    await run(async () => {
      const read = readBet(form);
      if (read.error) {
        formError(form, read.error);
        return;
      }
      const bet = await api.post("/api/bets", {
        eventId: form.dataset.eventId,
        ...betPayload(read.value),
      });
      modal.close();
      toast(`${bet.taker.name} has to accept before this is on the book.`);
      if (location.hash.startsWith("#/board")) render();
      else location.hash = "#/board";
    });
    return;
  }
  if (kind === "edit-bet") {
    await run(async () => {
      const read = readBet(form);
      if (read.error) {
        formError(form, read.error);
        return;
      }
      await api.patch(`/api/bets/${encodeURIComponent(form.dataset.id)}`, betPayload(read.value));
      modal.close();
      toast("Bet updated.");
      render();
    });
    return;
  }
  if (kind === "note-bet") {
    await run(async () => {
      await api.patch(`/api/bets/${encodeURIComponent(form.dataset.id)}`, { note: form.note.value });
      modal.close();
      toast("Note saved.");
      render();
    });
    return;
  }
  if (kind === "custom-event") {
    await run(async () => {
      const title = form.title.value.trim();
      if (!title) {
        formError(form, "Name the event.");
        return;
      }
      const sport = form.sport.value;
      const created = await api.post("/api/events", {
        title,
        sport,
        league: sport === "custom" ? form.league.value : "",
        startTime: fromLocal(form.start.value),
        status: form.status.value,
        competitors: [form.sideA.value, form.sideB.value, form.sideC.value],
      });
      modal.close();
      toast("Event added.");
      state.sport = created.sport;
      localStorage.setItem("marker.sport", state.sport);
      if (state.route === "events") render();
      else location.hash = "#/events";
    });
    return;
  }
  if (kind === "past-bet") {
    await run(async () => {
      const read = readBet(form);
      if (read.error) {
        formError(form, read.error);
        return;
      }
      const title = form.title.value.trim();
      if (!title) {
        formError(form, "Name the event.");
        return;
      }
      if (read.value.makerId !== state.me && read.value.takerId !== state.me) {
        formError(form, "You have to be on a bet you log.");
        return;
      }
      const sport = form.sport.value;
      await api.post("/api/bets", {
        event: {
          title,
          sport,
          league: sport === "custom" ? form.league.value : "",
          startTime: fromLocal(form.start.value),
          competitors: [read.value.makerPick, read.value.takerPick],
        },
        outcome: form.outcome.value,
        ...betPayload(read.value),
      });
      modal.close();
      toast("Logged in the book.");
      render();
    });
  }
}

function betPayload(value) {
  return {
    makerId: value.makerId,
    takerId: value.takerId,
    makerPick: value.makerPick,
    takerPick: value.takerPick,
    makerStake: value.makerStake,
    takerStake: value.takerStake,
    currency: value.currency,
    note: value.note,
  };
}

async function openBet(eventId) {
  await run(async () => {
    const event = state.events.find((item) => item.id === eventId) || await api.get(`/api/events/${encodeURIComponent(eventId)}`);
    openModal(betHtml(event), (dialog) => {
      const form = dialog.querySelector("form");
      form.dataset.eventId = event.id;
      form.dataset.competitors = JSON.stringify(event.competitors || []);
      const sideOk = (event.competitors || []).length >= 2;
      form.dataset.sideok = sideOk ? "1" : "";
      setBetMode(form, sideOk ? "side" : "prop");
      markCurrency(form, state.currency);
      sideReadout(form);
    });
  });
}

function betHtml(event) {
  const comps = event.competitors || [];
  const many = comps.length > 2;
  const side = comps.length >= 2;
  const alone = state.people.length < 2;
  const picks = comps.length === 2
    ? `<div class="pick-grid">${comps.map((comp) => `
        <button type="button" class="pick" data-action="pick-side" data-name="${esc(comp.name)}">
          <strong>${comp.rank ? `#${comp.rank} ` : ""}${esc(comp.name)}</strong>
          <span>${esc([comp.record, comp.side].filter(Boolean).join(" · "))}</span>
        </button>`).join("")}</div><p class="pick-readout">Choose a side.</p>`
    : many
      ? `<div class="split">
          <label>Your pick <select name="makerSide">${comps.map((comp) => `<option value="${esc(comp.name)}">${esc(comp.name)}</option>`).join("")}</select></label>
          <label>Their pick <select name="takerSide">${comps.map((comp, index) => `<option value="${esc(comp.name)}" ${index === 1 ? "selected" : ""}>${esc(comp.name)}</option>`).join("")}</select></label>
        </div>`
      : "";
  return `<form data-form="bet" autocomplete="off">
    <div class="spread"><div><p class="kicker">${esc(event.league)} · ${esc(formatWhen(event.startTime))}</p><h2>${esc(event.title)}</h2></div><button type="button" class="btn ghost small" data-action="close-modal">Close</button></div>
    ${event.subtitle ? `<p class="muted">${esc(event.subtitle)}</p>` : ""}
    <p class="form-error" hidden></p>
    <input type="hidden" name="makerId" value="${esc(state.me)}">
    ${alone
      ? `<p class="banner warn">A friend has to create an account before you can propose a bet.</p>`
      : `<label>Friend <select name="takerId">${peopleOptions(otherId(state.me), state.me)}</select></label>`}
    ${side ? `<div class="segmented">
      <button type="button" data-action="bet-mode" data-mode="side" class="on">Sides</button>
      <button type="button" data-action="bet-mode" data-mode="prop">Prop</button>
    </div>` : ""}
    <input type="hidden" name="mode" value="${side ? "side" : "prop"}">
    <div class="side-picks">${picks}</div>
    <div class="prop-picks" ${side ? "hidden" : ""}>
      <label>Your pick <input name="makerProp" placeholder="Over 47.5, podium, distance…"></label>
      <label>Their pick <input name="takerProp" placeholder="The other side of the prop"></label>
    </div>
    ${stakeFields("", "", "Your stake", "Their stake")}
    <label>Note <input name="note" maxlength="500" placeholder="Optional"></label>
    <p class="fine">Each of you puts up a stake in the same currency. Lose, and you owe your stake. Win, and you collect theirs. This stays a proposal until your friend accepts it.</p>
    <button class="btn primary" type="submit" ${alone ? "disabled" : ""}>Propose bet</button>
  </form>`;
}

function openEdit(betId) {
  const bet = findBet(betId);
  if (!bet || bet.status !== "proposed" || bet.maker.id !== state.me) {
    toast("Only a proposal you wrote can be edited.");
    return;
  }
  openModal(editHtml(bet), (dialog) => {
    const form = dialog.querySelector("form");
    markCurrency(form, bet.currency.code);
    updatePreview(form);
  });
}

function editHtml(bet) {
  return `<form data-form="edit-bet" data-id="${esc(bet.id)}" autocomplete="off">
    <div class="spread"><h2>Edit proposal</h2><button type="button" class="btn ghost small" data-action="close-modal">Close</button></div>
    <p class="muted">${esc(bet.eventTitle)}</p>
    <p class="form-error" hidden></p>
    <input type="hidden" name="mode" value="prop">
    <input type="hidden" name="makerId" value="${esc(state.me)}">
    <label>Friend <select name="takerId">${peopleOptions(bet.taker.id, state.me)}</select></label>
    <div class="prop-picks">
      <label>Your pick <input name="makerProp" value="${esc(bet.makerPick)}"></label>
      <label>Their pick <input name="takerProp" value="${esc(bet.takerPick)}"></label>
    </div>
    ${stakeFields(bet.makerStake, bet.takerStake, "Your stake", "Their stake")}
    <label>Note <input name="note" maxlength="500" value="${esc(bet.note || "")}"></label>
    <button class="btn primary" type="submit">Save changes</button>
  </form>`;
}

function openNote(betId) {
  const bet = findBet(betId);
  if (!bet) {
    toast("That bet isn't on this page anymore.");
    return;
  }
  openModal(`<form data-form="note-bet" data-id="${esc(bet.id)}" autocomplete="off">
    <div class="spread"><h2>Note</h2><button type="button" class="btn ghost small" data-action="close-modal">Close</button></div>
    <p class="muted">${esc(bet.eventTitle)}</p>
    <label>Note <input name="note" maxlength="500" value="${esc(bet.note || "")}"></label>
    <button class="btn primary" type="submit">Save note</button>
  </form>`);
}

function openCustom() {
  openModal(customHtml(), (dialog) => toggleLeague(dialog.querySelector("form")));
}

function customHtml() {
  const options = state.sports.map((sport) => `
    <option value="${esc(sport.id)}" ${sport.id === state.sport ? "selected" : ""}>${esc(sport.id === "custom" ? "Something else" : sport.label)}</option>`).join("");
  return `<form data-form="custom-event" autocomplete="off">
    <div class="spread"><h2>Custom event</h2><button type="button" class="btn ghost small" data-action="close-modal">Close</button></div>
    <p class="muted">A futures bet, a game the feed missed, or something that isn't a sport at all.</p>
    <p class="form-error" hidden></p>
    <label>Event <input name="title" maxlength="160" placeholder="NBA MVP, Sunday pickleball…" required></label>
    <label>Category <select name="sport">${options}</select></label>
    <label class="league-field">What is it? <input name="league" maxlength="40" placeholder="Pickleball, chess, the Oscars"></label>
    <div class="split">
      <label>When <input name="start" type="datetime-local" value="${localInputValue()}"></label>
      <label>Status <select name="status"><option value="scheduled">Upcoming</option><option value="final">Already over</option></select></label>
    </div>
    <div class="split">
      <label>Side A <input name="sideA" placeholder="Optional"></label>
      <label>Side B <input name="sideB" placeholder="Optional"></label>
    </div>
    <label>Side C <input name="sideC" placeholder="Optional"></label>
    <button class="btn primary" type="submit">Add event</button>
  </form>`;
}

function openPast() {
  openModal(pastHtml(), (dialog) => {
    const form = dialog.querySelector("form");
    markCurrency(form, state.currency);
    labelOutcomes(form);
    toggleLeague(form);
  });
}

function pastHtml() {
  const options = state.sports.map((sport) => `
    <option value="${esc(sport.id)}" ${sport.id === "custom" ? "selected" : ""}>${esc(sport.id === "custom" ? "Something else" : sport.label)}</option>`).join("");
  return `<form data-form="past-bet" autocomplete="off">
    <div class="spread"><h2>Log a settled bet</h2><button type="button" class="btn ghost small" data-action="close-modal">Close</button></div>
    <p class="muted">For action you already shook on. It goes straight into the record. You have to be one of the two people.</p>
    <p class="form-error" hidden></p>
    <input type="hidden" name="mode" value="prop">
    <label>Event <input name="title" maxlength="160" required></label>
    <label>Category <select name="sport">${options}</select></label>
    <label class="league-field">What is it? <input name="league" maxlength="40"></label>
    <label>When <input name="start" type="datetime-local" value="${localInputValue()}"></label>
    <div class="split">
      <label>First person <select name="makerId">${peopleOptions(state.me)}</select></label>
      <label>Second person <select name="takerId">${peopleOptions(otherId(state.me), state.me)}</select></label>
    </div>
    <div class="prop-picks">
      <label>First pick <input name="makerProp" placeholder="Who or what they took"></label>
      <label>Second pick <input name="takerProp" placeholder="The other side"></label>
    </div>
    ${stakeFields()}
    <label>Result <select name="outcome"><option value="maker">First person won</option><option value="taker">Second person won</option><option value="push">Push</option></select></label>
    <label>Note <input name="note" maxlength="500"></label>
    <p class="stake-preview"></p>
    <button class="btn primary" type="submit">Log it</button>
  </form>`;
}

function stakeFields(makerStake = "", takerStake = "", makerLabel = "First stake", takerLabel = "Second stake") {
  return `<div class="currency-picks">
      <button type="button" data-action="pick-currency" data-code="USD">USD</button>
      <button type="button" data-action="pick-currency" data-code="VND">Dong</button>
      <button type="button" data-action="pick-currency" data-code="GOLD">Gold bars</button>
    </div>
    <label>Other currency
      <select name="currencyMore">
        <option value="">Quick picks above</option>
        ${state.currencies.map((currency) => `<option value="${esc(currency.code)}">${esc(currency.name)}</option>`).join("")}
      </select>
    </label>
    <input type="hidden" name="currency" value="${esc(state.currency)}">
    <div class="split">
      <label>${esc(makerLabel)} <input name="makerStake" inputmode="decimal" autocomplete="off" value="${esc(makerStake)}"></label>
      <label>${esc(takerLabel)} <input name="takerStake" inputmode="decimal" autocomplete="off" value="${esc(takerStake)}"></label>
    </div>
    <button type="button" class="btn ghost small" data-action="same-stake">Same amount</button>
    <p class="stake-preview"></p>`;
}

function peopleOptions(selected, exclude) {
  return state.people
    .filter((person) => person.id !== exclude)
    .map((person) => `<option value="${esc(person.id)}" ${person.id === selected ? "selected" : ""}>${esc(person.name)}</option>`)
    .join("");
}

function otherId(id) {
  return state.people.find((person) => person.id !== id)?.id || "";
}

function readBet(form) {
  const currency = currencyByCode(form.currency?.value);
  if (!currency) return { error: "Choose a currency." };
  const makerId = form.makerId?.value || "";
  const takerId = form.takerId?.value || "";
  if (!makerId || !takerId) return { error: "Pick who is on each side." };
  if (makerId === takerId) return { error: "A bet needs two different people." };
  const mode = form.mode?.value || "prop";
  let makerPick = "";
  let takerPick = "";
  if (mode === "side" && form.dataset.sideok === "1" && form.makerSide) {
    makerPick = form.makerSide.value.trim();
    takerPick = form.takerSide.value.trim();
  } else if (mode === "side" && form.dataset.sideok === "1") {
    makerPick = form.dataset.makerPick || "";
    takerPick = form.dataset.takerPick || "";
  } else {
    makerPick = form.makerProp?.value.trim() || "";
    takerPick = form.takerProp?.value.trim() || "";
  }
  if (!makerPick || !takerPick) return { error: "Both sides need a pick." };
  if (makerPick.toLowerCase() === takerPick.toLowerCase()) return { error: "The two picks are the same." };
  const makerStake = parseStake(form.makerStake.value, currency);
  const takerStake = parseStake(form.takerStake.value, currency);
  if (makerStake == null || takerStake == null) return { error: "Enter both stakes. Use 0 for a pride bet." };
  if (Number.isNaN(makerStake) || Number.isNaN(takerStake)) return { error: "Those stakes are not numbers." };
  const maker = state.people.find((person) => person.id === makerId);
  const taker = state.people.find((person) => person.id === takerId);
  return {
    value: {
      makerId,
      takerId,
      makerPick,
      takerPick,
      makerStake,
      takerStake,
      currency: currency.code,
      note: form.note?.value || "",
      maker,
      taker,
      currencyObj: currency,
    },
  };
}

function updatePreview(form) {
  const preview = form.querySelector(".stake-preview");
  if (!preview || !form.makerStake) return;
  const read = readBet(form);
  if (read.error || !read.value?.maker) {
    preview.textContent = "";
    return;
  }
  const value = read.value;
  const yours = formatMoney(value.makerStake, value.currencyObj);
  const theirs = formatMoney(value.takerStake, value.currencyObj);
  const stakes = value.makerStake === value.takerStake
    ? `${value.maker.name} and ${value.taker.name} put up ${yours} each.`
    : `${value.maker.name} puts up ${yours} against ${value.taker.name}'s ${theirs}.`;
  preview.textContent = `${stakes} ${value.maker.name} has ${value.makerPick}. ${value.taker.name} has ${value.takerPick}.`;
}

function sideReadout(form) {
  const readout = form.querySelector(".pick-readout");
  if (!readout) return;
  const maker = state.people.find((person) => person.id === form.makerId?.value);
  const taker = state.people.find((person) => person.id === form.takerId?.value);
  if (!form.dataset.makerPick) {
    readout.textContent = "Choose a side.";
    return;
  }
  readout.textContent = `${maker?.name || "You"} has ${form.dataset.makerPick}. ${taker?.name || "Friend"} has ${form.dataset.takerPick || "…"}.`;
}

function pickSide(button) {
  const form = button.closest("form");
  const comps = JSON.parse(form.dataset.competitors || "[]");
  const name = button.dataset.name;
  form.dataset.makerPick = name;
  const other = comps.find((comp) => comp.name !== name);
  form.dataset.takerPick = other ? other.name : "";
  form.querySelectorAll(".pick").forEach((el) => el.classList.toggle("on", el.dataset.name === name));
  sideReadout(form);
  updatePreview(form);
}

function setBetMode(form, mode) {
  if (!form?.mode) return;
  form.mode.value = mode;
  form.querySelectorAll("[data-action=bet-mode]").forEach((button) => {
    button.classList.toggle("on", button.dataset.mode === mode);
  });
  const side = form.querySelector(".side-picks");
  const prop = form.querySelector(".prop-picks");
  if (side) side.hidden = mode !== "side";
  if (prop) prop.hidden = mode !== "prop";
  updatePreview(form);
}

function markCurrency(form, code) {
  if (!form?.currency) return;
  const known = currencyByCode(code);
  form.currency.value = known?.code || code;
  state.currency = form.currency.value;
  localStorage.setItem("marker.currency", state.currency);
  form.querySelectorAll("[data-action=pick-currency]").forEach((button) => {
    button.classList.toggle("on", button.dataset.code === state.currency);
  });
  const more = form.querySelector("[name=currencyMore]");
  if (more) more.value = ["USD", "VND", "GOLD"].includes(state.currency) ? "" : state.currency;
}

function syncTaker(form) {
  if (!form.takerId || !form.makerId) return;
  const current = form.takerId.value;
  const options = state.people.filter((person) => person.id !== form.makerId.value);
  form.takerId.innerHTML = options.map((person) => `<option value="${esc(person.id)}">${esc(person.name)}</option>`).join("");
  if (options.some((person) => person.id === current)) form.takerId.value = current;
  sideReadout(form);
}

function labelOutcomes(form) {
  if (form.dataset.form !== "past-bet" || !form.outcome) return;
  const maker = state.people.find((person) => person.id === form.makerId.value);
  const taker = state.people.find((person) => person.id === form.takerId.value);
  const makerOption = form.outcome.querySelector('option[value="maker"]');
  const takerOption = form.outcome.querySelector('option[value="taker"]');
  if (makerOption) makerOption.textContent = `${maker?.name || "First person"} won`;
  if (takerOption) takerOption.textContent = `${taker?.name || "Second person"} won`;
}

function toggleLeague(form) {
  const field = form.querySelector(".league-field");
  if (!field || !form.sport) return;
  field.hidden = form.sport.value !== "custom";
}

async function settleBet(id, result) {
  if (result === "void" && !window.confirm("Void this bet? It leaves the record and nobody owes anything.")) return;
  await run(async () => {
    await api.post(`/api/bets/${encodeURIComponent(id)}/settle`, { result });
    toast(result === "void" ? "Voided." : result === "push" ? "Marked as a push." : "Settled.");
    render();
  });
}

async function reopenBet(id) {
  if (!window.confirm("Reopen this bet? It leaves the record until you settle it again.")) return;
  await run(async () => {
    await api.post(`/api/bets/${encodeURIComponent(id)}/reopen`, {});
    toast("Reopened. It's back on the board.");
    location.hash = "#/board";
    if (state.route === "board") render();
  });
}

async function answerBet(id, action) {
  if (action === "decline" && !window.confirm("Decline this bet? It won't go on the book.")) return;
  if (action === "withdraw" && !window.confirm("Take this bet back?")) return;
  const messages = {
    accept: "Accepted. It's on the book.",
    decline: "Declined.",
    withdraw: "Taken back.",
  };
  await run(async () => {
    await api.post(`/api/bets/${encodeURIComponent(id)}/${action}`, {});
    toast(messages[action]);
    render();
  });
}

async function deletePerson(id, name) {
  if (id !== state.me) return;
  if (!window.confirm(`Remove your account${name ? `, ${name}` : ""}? This only works if you have no bets.`)) return;
  await run(async () => {
    await api.del(`/api/people/${encodeURIComponent(id)}`);
    state.me = "";
    state.people = [];
    renderAuth();
    toast("Account removed.");
  });
}

async function deleteCurrency(code) {
  if (!window.confirm(`Remove ${code} from the book?`)) return;
  await run(async () => {
    await api.del(`/api/currencies/${encodeURIComponent(code)}`);
    await reloadMeta();
    toast("Currency removed.");
    render();
  });
}

function findBet(id) {
  return (state.board?.bets || []).find((bet) => bet.id === id)
    || (state.history || []).find((bet) => bet.id === id);
}

function openModal(html, after) {
  modal.innerHTML = `<div class="modal-card">${html}</div>`;
  if (after) after(modal);
  if (!modal.open) modal.showModal();
}

function formError(form, message) {
  const el = form.querySelector(".form-error");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

function emptyBlock(title, copy, retry) {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(copy)}</p>${retry ? '<button type="button" class="btn" data-action="retry">Try again</button>' : ""}</div>`;
}

function sportLabel(id) {
  return state.sports.find((sport) => sport.id === id)?.label || id || "";
}

function currencyByCode(code) {
  return state.currencies.find((currency) => currency.code === code) || null;
}

function currentQuery() {
  const hash = location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  return new URLSearchParams(query);
}

function fromLocal(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

async function run(work) {
  if (state.busy) return;
  state.busy = true;
  try {
    await work();
  } catch (error) {
    if (error.status === 401) {
      state.me = "";
      renderAuth();
      toast("Sign in to use the book.");
      return;
    }
    toast(error.message || "Something went wrong.");
  } finally {
    state.busy = false;
  }
}

let toastTimer = 0;
function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 3200);
}
