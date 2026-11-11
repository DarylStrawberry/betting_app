import { esc, formatMoney, formatWhen, stakeSentence } from "./format.js";
import { decodeBundle, encodeBundle, importPrivate, signEntry, verifyEnvelope } from "./crypto.js";
import { CURRENCIES, assertName, assertProposal, colorFor, fold, fromMinor, standings, toMinor } from "./ledger.js";
import { addEntries, loadBook, replaceBook, saveMe } from "./store.js";
import { createIdentity } from "./crypto.js";

const app = document.querySelector("#app");
const state = {
  ready: false,
  secure: window.isSecureContext,
  me: null,
  privateKey: null,
  pkcs8: "",
  entries: [],
  names: {},
  bets: {},
  bundle: "",
  busy: false,
};

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const control = target.closest("[data-action]");
  if (!control) return;
  onAction(control);
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  onSubmit(form);
});

window.addEventListener("hashchange", () => {
  if (state.ready) render();
});

boot();

async function boot() {
  if (!state.secure) {
    state.ready = true;
    render();
    return;
  }
  try {
    const saved = await loadBook();
    const verified = [];
    for (const item of saved.entries) {
      if (await verifyEnvelope(item)) verified.push(item);
    }
    state.entries = verified;
    if (saved.me?.pub && saved.me?.pkcs8) {
      state.me = saved.me;
      state.pkcs8 = saved.me.pkcs8;
      state.privateKey = await importPrivate(saved.me.pkcs8);
    }
    refresh();
    state.ready = true;
    render();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  } catch (error) {
    app.innerHTML = `<section class="pad"><h1>The book didn't open.</h1><p>${esc(error.message)}</p></section>`;
  }
}

function refresh() {
  const folded = fold(state.entries);
  state.names = folded.names;
  state.bets = folded.bets;
  state.bundle = state.me ? encodeBundle(state.entries) : "";
}

function render() {
  if (!state.secure) {
    app.innerHTML = insecureHtml();
    return;
  }
  if (!state.me) {
    document.body.classList.remove("has-nav");
    app.innerHTML = setupHtml();
    app.querySelector("input[name=name]")?.focus();
    return;
  }
  document.body.classList.add("has-nav");
  const route = routeName();
  app.innerHTML = shell(page(route));
  const outgoing = app.querySelector("#send-text");
  if (outgoing) outgoing.value = state.bundle;
}

function routeName() {
  const raw = location.hash.replace(/^#\/?/, "");
  const name = raw.split("/")[0] || "board";
  if (["board", "history", "records", "friends", "new"].includes(name)) return name;
  if (name === "bet") return "bet";
  return "board";
}

function betIdFromHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/");
  if (parts[0] !== "bet") return "";
  return decodeURIComponent(parts.slice(1).join("/"));
}

function shell(content) {
  const me = person(state.me.pub);
  const route = routeName();
  const link = (id, label) => `<a href="#/${id}" class="${route === id ? "on" : ""}">${label}</a>`;
  return `
    <div class="page">
      <header class="top">
        <div>
          <p class="kicker">Marker</p>
          <strong class="who"><span class="swatch" style="background:${esc(me.color)}"></span>${esc(me.name)}</strong>
        </div>
        <a class="btn small" href="#/new">New bet</a>
      </header>
      ${installHint()}
      ${content}
      <details class="pass" ${needsFriend() ? "open" : ""}>
        <summary>Pass an update</summary>
        <p class="muted">Send this text to the other phone. Paste what they send under it. This does not include your private key.</p>
        <textarea id="send-text" readonly rows="4"></textarea>
        <div class="actions">
          <button type="button" class="btn" data-action="copy-send">Copy</button>
          <button type="button" class="btn" data-action="share-send">Share</button>
        </div>
        <label>From their phone
          <textarea id="receive-text" rows="4" placeholder="Paste their update"></textarea>
        </label>
        <button type="button" class="btn primary" data-action="receive">Add to this phone</button>
      </details>
    </div>
    <nav class="nav">
      ${link("board", "Board")}
      ${link("history", "History")}
      ${link("records", "Records")}
      ${link("friends", "Friends")}
    </nav>`;
}

function page(route) {
  if (route === "new") return newBetHtml();
  if (route === "bet") return betHtml(betIdFromHash());
  if (route === "history") return historyHtml();
  if (route === "records") return recordsHtml();
  if (route === "friends") return friendsHtml();
  return boardHtml();
}

function boardHtml() {
  const bets = Object.values(state.bets);
  const incoming = bets.filter((bet) => bet.status === "proposed" && bet.taker === state.me.pub);
  const outgoing = bets.filter((bet) => bet.status === "proposed" && bet.maker === state.me.pub);
  const open = bets.filter((bet) => bet.status === "open");
  const any = incoming.length || outgoing.length || open.length;
  const closed = bets.some((bet) => ["settled", "push", "void", "declined", "withdrawn"].includes(bet.status));
  const friends = Object.keys(state.names).filter((pub) => pub !== state.me.pub);
  const empty = closed
    ? `<div class="empty"><h2>Nothing waiting</h2><p>Settled bets are in History.</p></div>`
    : friends.length
      ? `<div class="empty"><h2>No bets yet</h2><p>Propose one, or wait for theirs to arrive.</p></div>`
      : `<div class="empty"><h2>Nothing on this phone yet</h2><p>Send your update to a friend, and paste theirs back. A bet counts only after their phone accepts it.</p></div>`;
  return `
    <section>
      <h1>The book</h1>
      ${section("For you to answer", incoming, true)}
      ${section("Waiting on them", outgoing, true)}
      ${section("On the book", open)}
      ${any ? "" : empty}
    </section>`;
}

function section(title, bets, respond = false) {
  if (!bets.length) return "";
  const ordered = [...bets].sort((a, b) => String(a.start || a.at).localeCompare(String(b.start || b.at)));
  return `<section class="block"><h2>${esc(title)}</h2><div class="stack">${ordered.map((bet) => card(bet, false, respond)).join("")}</div></section>`;
}

function historyHtml() {
  const closed = Object.values(state.bets)
    .filter((bet) => ["settled", "push", "void", "declined", "withdrawn"].includes(bet.status))
    .sort((a, b) => String(b.settledAt || b.at).localeCompare(String(a.settledAt || a.at)));
  return `
    <section>
      <h1>History</h1>
      ${closed.length ? `<div class="stack">${closed.map(card).join("")}</div>` : `<div class="empty"><h2>No settled bets</h2><p>Accepted bets show up here after someone settles them.</p></div>`}
    </section>`;
}

function recordsHtml() {
  const { leaderboard, owes, pairs } = standings(state.bets, state.names, [state.me.pub]);
  const rows = leaderboard.map((row) => {
    const who = person(row.pub);
    const nets = row.nets.map((net) => signed(net.minor, net.currency)).join(", ") || "Even";
    return `<article class="card">
      <div class="spread"><strong class="who"><span class="swatch" style="background:${esc(who.color)}"></span>${esc(who.name)}</strong><span>${row.wins}–${row.losses}${row.pushes ? `–${row.pushes}` : ""}</span></div>
      <p class="muted">${esc(row.streak || "No streak")} · ${esc(nets)}</p>
    </article>`;
  }).join("");
  const oweText = owes.map((owe) => {
    const amount = formatMoney(fromMinor(owe.minor, owe.currency.decimals), owe.currency);
    const from = person(owe.from).name;
    const to = person(owe.to).name;
    if (owe.from === state.me.pub) return `You owe ${to} ${amount}.`;
    if (owe.to === state.me.pub) return `${from} owes you ${amount}.`;
    return `${from} owes ${to} ${amount}.`;
  }).join(" ");
  const pairText = pairs.map((pair) => {
    const a = person(pair.a).name;
    const b = person(pair.b).name;
    const pushes = pair.pushes ? `, ${pair.pushes} ${pair.pushes === 1 ? "push" : "pushes"}` : "";
    if (pair.aWins === pair.bWins) return `The series is tied, ${pair.aWins}–${pair.bWins}${pushes}.`;
    if (pair.aWins > pair.bWins) return `${a} leads ${pair.aWins}–${pair.bWins}${pushes}.`;
    return `${b} leads ${pair.bWins}–${pair.aWins}${pushes}.`;
  }).join(" ");
  return `
    <section>
      <h1>Records</h1>
      <div class="stack">${rows || `<p class="muted">No settled bets yet.</p>`}</div>
      ${oweText ? `<h2>Who owes whom</h2><p>${esc(oweText)}</p>` : ""}
      ${pairText ? `<h2>Head to head</h2><p>${esc(pairText)}</p>` : ""}
    </section>`;
}

function friendsHtml() {
  const others = Object.keys(state.names).filter((pub) => pub !== state.me.pub);
  const list = others.map((pub) => {
    const who = person(pub);
    return `<div class="person"><span class="swatch" style="background:${esc(who.color)}"></span><strong>${esc(who.name)}</strong></div>`;
  }).join("");
  return `
    <section>
      <h1>Friends</h1>
      <p class="muted">Each phone has its own key. Send the update above so they can add you. Paste theirs to add them.</p>
      <div class="stack">${list || `<p class="muted">No one else is on this phone yet.</p>`}</div>
      <form data-form="rename" class="stack tight">
        <label>Your name <input name="name" maxlength="40" value="${esc(person(state.me.pub).name)}"></label>
        <button class="btn" type="submit">Save name</button>
      </form>
      <div class="actions">
        <button type="button" class="btn" data-action="backup">Back up this phone</button>
        <label class="btn">Restore<input id="restore-file" type="file" accept="application/json,.json" hidden></label>
      </div>
      <p class="fine">The backup can sign bets as you. Keep it. Don't send it to your friend.</p>
    </section>`;
}

function newBetHtml() {
  const friends = Object.keys(state.names).filter((pub) => pub !== state.me.pub);
  if (!friends.length) {
    return `<section><h1>New bet</h1><div class="empty"><h2>Add your friend first</h2><p>Paste their update under Pass an update. Then their name can go on a bet.</p></div></section>`;
  }
  const options = friends.map((pub) => `<option value="${esc(pub)}">${esc(person(pub).name)}</option>`).join("");
  const currencies = Object.values(CURRENCIES).map((currency) => `<option value="${esc(currency.code)}">${esc(currency.name)}</option>`).join("");
  return `
    <section>
      <h1>New bet</h1>
      <form data-form="proposal" class="stack">
        <p class="form-error" hidden></p>
        <label>Friend <select name="taker">${options}</select></label>
        <label>Event <input name="title" maxlength="140" placeholder="Sunday pickleball" required></label>
        <label>When <input name="start" type="datetime-local"></label>
        <label>Your pick <input name="makerPick" maxlength="80" required></label>
        <label>Their pick <input name="takerPick" maxlength="80" required></label>
        <div class="split">
          <label>Your stake <input name="makerStake" inputmode="decimal" value="0"></label>
          <label>Their stake <input name="takerStake" inputmode="decimal" value="0"></label>
        </div>
        <label>Currency <select name="currency">${currencies}<option value="OTHER">Other</option></select></label>
        <div class="custom-currency" hidden>
          <label>Code <input name="code" maxlength="8" placeholder="BEER"></label>
          <label>Name <input name="currencyName" maxlength="40" placeholder="Beer"></label>
          <label>Symbol <input name="symbol" maxlength="8" placeholder="🍺"></label>
          <label>Decimals <input name="decimals" inputmode="numeric" value="0"></label>
        </div>
        <label>Note <input name="note" maxlength="500" placeholder="Optional"></label>
        <p class="fine">Type the event yourself. They have to accept before this counts. Lose, and you owe your stake. Win, and you collect theirs.</p>
        <button class="btn primary" type="submit">Propose bet</button>
      </form>
    </section>`;
}

function betHtml(id) {
  const bet = state.bets[id];
  if (!bet) return `<section><h1>That bet isn't on this phone.</h1><p><a href="#/board">Back to the board</a></p></section>`;
  return `<section><p class="kicker">${esc(formatWhen(bet.start || bet.at))}</p><div class="stack">${card(bet, true)}</div></section>`;
}

function card(bet, detail = false, respond = false) {
  const view = viewBet(bet);
  const mine = bet.maker === state.me.pub || bet.taker === state.me.pub;
  return `<article class="card bet ${mine ? "mine" : ""}">
    <a class="spread" href="#/bet/${encodeURIComponent(bet.id)}">
      <div><p class="kicker">${esc(statusLabel(bet))}</p><h2>${esc(bet.title)}</h2></div>
    </a>
    <div class="sides">
      ${side(view.maker, view.makerPick, view.makerStake, view.currency, bet.status === "settled" && bet.winner === bet.maker)}
      ${side(view.taker, view.takerPick, view.takerStake, view.currency, bet.status === "settled" && bet.winner === bet.taker)}
    </div>
    <p class="stake">${esc(stakeSentence(view))}</p>
    ${bet.note ? `<p class="note">${esc(bet.note)}</p>` : ""}
    ${detail ? actions(bet) : respond ? respondActions(bet) : ""}
  </article>`;
}

function side(who, pick, stake, currency, won) {
  return `<div class="side ${won ? "won" : ""}">
    <span class="swatch" style="background:${esc(who.color)}"></span>
    <div><strong>${esc(who.name)}</strong><span>${esc(pick)}</span></div>
    <b>${esc(formatMoney(stake, currency))}</b>
  </div>`;
}

function respondActions(bet) {
  const me = state.me.pub;
  if (bet.status === "proposed" && bet.taker === me) {
    return `<div class="actions">
      <button type="button" class="btn primary" data-action="accept" data-id="${esc(bet.id)}">Accept</button>
      <button type="button" class="btn danger" data-action="decline" data-id="${esc(bet.id)}">Decline</button>
    </div>`;
  }
  if (bet.status === "proposed" && bet.maker === me) {
    return `<div class="actions">
      <button type="button" class="btn danger" data-action="withdraw" data-id="${esc(bet.id)}">Withdraw</button>
      <p class="fine">To change the terms, withdraw this and propose it again.</p>
    </div>`;
  }
  return "";
}

function actions(bet) {
  const quick = respondActions(bet);
  if (quick) return quick;
  const me = state.me.pub;
  if (bet.status === "open" && (bet.maker === me || bet.taker === me)) {
    const view = viewBet(bet);
    return `<div class="actions">
      <button type="button" class="btn" data-action="settle" data-id="${esc(bet.id)}" data-result="maker">${esc(view.maker.name)} won</button>
      <button type="button" class="btn" data-action="settle" data-id="${esc(bet.id)}" data-result="taker">${esc(view.taker.name)} won</button>
      <button type="button" class="btn" data-action="settle" data-id="${esc(bet.id)}" data-result="push">Push</button>
      <button type="button" class="btn danger" data-action="settle" data-id="${esc(bet.id)}" data-result="void">Void</button>
    </div>`;
  }
  if (["settled", "push", "void"].includes(bet.status) && (bet.maker === me || bet.taker === me)) {
    return `<div class="actions"><button type="button" class="btn" data-action="reopen" data-id="${esc(bet.id)}">Reopen</button></div>`;
  }
  return "";
}

function statusLabel(bet) {
  if (bet.status === "proposed" && bet.taker === state.me?.pub) return "Needs you";
  if (bet.status === "proposed" && bet.maker === state.me?.pub) return "Waiting";
  if (bet.status === "proposed") return "Proposed";
  if (bet.status === "open") return "On the book";
  if (bet.status === "settled") return `${person(bet.winner).name} won`;
  if (bet.status === "push") return "Push";
  if (bet.status === "void") return "Void";
  if (bet.status === "declined") return "Declined";
  if (bet.status === "withdrawn") return "Withdrawn";
  return bet.status;
}

function setupHtml() {
  return `
    <section class="pad">
      <p class="kicker">A private book</p>
      <h1>Make your side of the book.</h1>
      <p class="lede">This phone keeps your copy. Your friend keeps theirs. A bet counts only after their phone accepts it.</p>
      ${installHint()}
      <form data-form="setup" class="stack">
        <label>Your name <input name="name" maxlength="40" autocomplete="nickname" required></label>
        <p class="form-error" hidden></p>
        <button class="btn primary" type="submit">Create this phone's book</button>
      </form>
    </section>`;
}

function insecureHtml() {
  return `
    <section class="pad">
      <p class="kicker">Marker</p>
      <h1>Open the secure address.</h1>
      <p class="lede">This page can keep a private key only on an https address, or on this computer at 127.0.0.1. A plain http address such as 100.x or 192.168.x cannot sign bets.</p>
    </section>`;
}

function installHint() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  if (standalone || !state.secure) return "";
  return `<p class="banner">Add this page to your home screen once, while it is open. iPhone: in Safari, tap Share, then Add to Home Screen. Android: menu, Install app or Add to Home screen. After that, the book stays on the phone.</p>`;
}

function needsFriend() {
  return !Object.keys(state.names).some((pub) => pub !== state.me.pub);
}

function person(pub) {
  const named = Object.entries(state.names).filter(([, name]) => name && name === state.names[pub]);
  const base = state.names[pub] || "Unknown";
  return {
    id: pub,
    name: named.length > 1 ? `${base} · ${pub.slice(0, 4)}` : base,
    color: colorFor(pub),
  };
}

function viewBet(bet) {
  return {
    ...bet,
    maker: { ...person(bet.maker), name: person(bet.maker).name },
    taker: person(bet.taker),
    makerStake: fromMinor(bet.makerStake, bet.currency.decimals),
    takerStake: fromMinor(bet.takerStake, bet.currency.decimals),
  };
}

function signed(minor, currency) {
  const amount = fromMinor(minor, currency.decimals);
  const text = formatMoney(Math.abs(amount), currency);
  if (amount > 0) return `+${text}`;
  if (amount < 0) return `−${text}`;
  return text;
}

function onAction(control) {
  const action = control.dataset.action;
  const id = control.dataset.id;
  if (action === "copy-send") copySend();
  if (action === "share-send") shareSend();
  if (action === "receive") receive(document.querySelector("#receive-text")?.value || "");
  if (action === "accept") commit("accept", id);
  if (action === "decline") {
    if (window.confirm("Decline this bet? It won't go on the book.")) commit("decline", id);
  }
  if (action === "withdraw") {
    if (window.confirm("Take this bet back?")) commit("withdraw", id);
  }
  if (action === "settle") {
    if (control.dataset.result === "void" && !window.confirm("Void this bet? Nothing moves.")) return;
    commit("settle", id, { result: control.dataset.result });
  }
  if (action === "reopen") commit("reopen", id);
  if (action === "backup") downloadBackup();
}

async function onSubmit(form) {
  if (form.dataset.form === "setup") {
    await run(async () => {
      const name = assertName(form.name.value);
      const identity = await createIdentity();
      const env = await signEntry(identity.privateKey, profileEntry(identity.pub, name));
      const me = { name, pub: identity.pub, pkcs8: identity.pkcs8 };
      await replaceBook(me, [env]);
      state.me = me;
      state.pkcs8 = identity.pkcs8;
      state.privateKey = identity.privateKey;
      state.entries = [env];
      refresh();
      location.hash = "#/board";
      render();
      toast("This phone has a book. Send the update to your friend.");
    }, form);
    return;
  }
  if (form.dataset.form === "rename") {
    await run(async () => {
      const name = assertName(form.name.value);
      await commitEntry(profileEntry(state.me.pub, name));
      state.me = { ...state.me, name };
      await saveMe(state.me);
      toast("Name saved on this phone. Send the update so theirs changes too.");
      render();
    }, form);
    return;
  }
  if (form.dataset.form === "proposal") {
    await run(async () => {
      const currency = currencyFrom(form);
      const body = {
        betId: crypto.randomUUID(),
        taker: form.taker.value,
        title: form.title.value,
        start: form.start.value ? new Date(form.start.value).toISOString() : "",
        sport: "custom",
        makerPick: form.makerPick.value,
        takerPick: form.takerPick.value,
        makerStake: toMinor(form.makerStake.value, currency.decimals),
        takerStake: toMinor(form.takerStake.value, currency.decimals),
        currency,
        note: form.note.value,
      };
      assertProposal(state.me.pub, body);
      await commitEntry({
        v: 1,
        id: crypto.randomUUID(),
        type: "proposal",
        at: new Date().toISOString(),
        by: state.me.pub,
        body,
      });
      location.hash = `#/bet/${encodeURIComponent(body.betId)}`;
      toast("Proposed on this phone. Send the update. It counts when they accept.");
      render();
    }, form);
  }
}

function profileEntry(pub, name) {
  return { v: 1, id: crypto.randomUUID(), type: "profile", at: new Date().toISOString(), by: pub, body: { name } };
}

function currencyFrom(form) {
  if (form.currency.value !== "OTHER") return CURRENCIES[form.currency.value];
  const decimals = Number(form.decimals.value);
  return {
    code: form.code.value.trim().toUpperCase(),
    name: form.currencyName.value,
    symbol: form.symbol.value,
    decimals,
  };
}

async function commit(type, betId, extra = {}) {
  await run(async () => {
    await commitEntry({
      v: 1,
      id: crypto.randomUUID(),
      type,
      at: new Date().toISOString(),
      by: state.me.pub,
      body: { betId, ...extra },
    });
    toast("Saved on this phone. Send the update.");
    render();
  });
}

async function commitEntry(entry) {
  const env = await signEntry(state.privateKey, entry);
  if (!(await verifyEnvelope(env))) throw new Error("This phone couldn't sign that.");
  await addEntries([env]);
  state.entries.push(env);
  refresh();
}

async function receive(text) {
  await run(async () => {
    const incoming = decodeBundle(text);
    const good = [];
    let bad = 0;
    for (const item of incoming) {
      if (await verifyEnvelope(item)) good.push(item);
      else bad += 1;
    }
    const added = await addEntries(good);
    if (added) {
      const saved = await loadBook();
      state.entries = [];
      for (const item of saved.entries) {
        if (await verifyEnvelope(item)) state.entries.push(item);
      }
      refresh();
    }
    const box = document.querySelector("#receive-text");
    if (box) box.value = "";
    if (!added && bad) throw new Error("Nothing in that update checked out.");
    toast(added ? `Added ${added} update${added === 1 ? "" : "s"}.` : "This phone already had that.");
    render();
  });
}

async function copySend() {
  const text = state.bundle;
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied. Send it in a message.");
  } catch {
    const box = document.querySelector("#send-text");
    box?.focus();
    box?.select();
    toast("Select the update text and copy it.");
  }
}

async function shareSend() {
  const text = state.bundle;
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
    }
  }
  await copySend();
}

function downloadBackup() {
  const payload = {
    v: 1,
    kind: "backup",
    me: { name: state.me.name, pub: state.me.pub, pkcs8: state.pkcs8 },
    entries: state.entries,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "marker-backup.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast("Backup saved. Keep that file private.");
}

async function restoreFile(file) {
  if (!file) return;
  await run(async () => {
    const data = JSON.parse(await file.text());
    if (data?.kind !== "backup" || !data.me?.pub || !data.me?.pkcs8 || !Array.isArray(data.entries)) {
      throw new Error("That file is not a Marker backup.");
    }
    if (!window.confirm("Replace this phone's key with the backup? Do this only for your own backup.")) return;
    const verified = [];
    for (const item of data.entries) {
      if (await verifyEnvelope(item)) verified.push(item);
    }
    const privateKey = await importPrivate(data.me.pkcs8);
    await replaceBook(data.me, verified);
    state.me = data.me;
    state.pkcs8 = data.me.pkcs8;
    state.privateKey = privateKey;
    state.entries = verified;
    refresh();
    location.hash = "#/board";
    toast("Backup restored on this phone.");
    render();
  });
}

function formError(form, message) {
  const el = form?.querySelector?.(".form-error");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

async function run(work, form) {
  if (state.busy) return;
  state.busy = true;
  try {
    await work();
  } catch (error) {
    if (form) formError(form, error.message);
    toast(error.message || "Something went wrong.");
  } finally {
    state.busy = false;
  }
}

let toastTimer = 0;
function toast(message) {
  const el = document.querySelector("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 3600);
}

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === "restore-file") {
    const file = target.files?.[0];
    target.value = "";
    restoreFile(file);
    return;
  }
  if (!(target instanceof HTMLSelectElement) || target.name !== "currency") return;
  const custom = target.form?.querySelector(".custom-currency");
  if (custom) custom.hidden = target.value !== "OTHER";
});
