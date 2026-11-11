export const CURRENCIES = {
  USD: { code: "USD", name: "US dollar", symbol: "$", decimals: 2 },
  VND: { code: "VND", name: "Vietnamese dong", symbol: "₫", decimals: 0 },
  GOLD: { code: "GOLD", name: "Gold bar", symbol: "bar", decimals: 2 },
  EUR: { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
  GBP: { code: "GBP", name: "British pound", symbol: "£", decimals: 2 },
};

const PALETTE = ["#1f6a4e", "#8d6420", "#8e3b32", "#2a4e86", "#6a4584", "#1f6f78", "#8a4b2f", "#3e5c2f"];

export function assertName(value) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("Enter your name.");
  if ([...name].length > 40) throw new Error("That name is too long.");
  return name;
}

export function toMinor(raw, decimals) {
  let text = String(raw ?? "").trim().replace(/\s/g, "");
  if (!text) throw new Error("Enter both stakes. Use 0 for a pride bet.");
  if (decimals === 0) {
    text = text.replace(/[.,]/g, "");
  } else if (text.includes(",") && !text.includes(".")) {
    const parts = text.split(",");
    if (parts.length === 2 && parts[1].length > 0 && parts[1].length <= decimals) {
      text = `${parts[0].replace(/,/g, "")}.${parts[1]}`;
    } else {
      text = text.replace(/,/g, "");
    }
  } else {
    text = text.replace(/,/g, "");
  }
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("That stake is not a number.");
  const [whole, frac = ""] = text.split(".");
  if (frac.length > decimals) throw new Error("That stake has too many decimal places.");
  const minor = Number(whole + frac.padEnd(decimals, "0"));
  if (!Number.isSafeInteger(minor)) throw new Error("That stake is too large.");
  return minor;
}

export function fromMinor(minor, decimals) {
  const sign = minor < 0 ? -1 : 1;
  const digits = String(Math.abs(minor)).padStart((decimals || 0) + 1, "0");
  if (!decimals) return sign * Number(digits);
  return sign * Number(`${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`);
}

export function colorFor(pub) {
  let hash = 0;
  for (const ch of String(pub || "")) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export function assertProposal(by, body) {
  const betId = String(body?.betId || "");
  if (betId.length < 8 || betId.length > 80) throw new Error("That bet is missing an id.");
  const taker = String(body?.taker || "");
  if (!taker || taker === by) throw new Error("Pick the other person.");
  const title = clean(body?.title, 140);
  const makerPick = clean(body?.makerPick, 80);
  const takerPick = clean(body?.takerPick, 80);
  if (!title) throw new Error("Name the event.");
  if (!makerPick || !takerPick) throw new Error("Both sides need a pick.");
  if (makerPick.toLocaleLowerCase() === takerPick.toLocaleLowerCase()) throw new Error("The two picks are the same.");
  if (!Number.isSafeInteger(body?.makerStake) || !Number.isSafeInteger(body?.takerStake)) {
    throw new Error("Enter both stakes. Use 0 for a pride bet.");
  }
  if (body.makerStake < 0 || body.takerStake < 0) throw new Error("Stakes cannot be negative.");
  const currency = cleanCurrency(body?.currency);
  if (!currency) throw new Error("Choose a currency.");
  const note = cleanNote(body?.note);
  if (note == null) throw new Error("Keep the note under 500 characters.");
  const start = typeof body?.start === "string" && body.start.length <= 40 ? body.start : "";
  const sport = clean(body?.sport, 40) || "custom";
  return {
    id: betId,
    maker: by,
    taker,
    title,
    sport,
    start,
    makerPick,
    takerPick,
    makerStake: body.makerStake,
    takerStake: body.takerStake,
    currency,
    note,
  };
}

export function fold(envelopes) {
  const ordered = [...envelopes].filter((item) => item?.entry?.v === 1).sort((a, b) => {
    const byTime = String(a.entry.at).localeCompare(String(b.entry.at));
    return byTime || String(a.entry.id).localeCompare(String(b.entry.id));
  });
  const names = {};
  const bets = {};
  for (const item of ordered) apply(names, bets, item.entry);
  return { names, bets };
}

export function standings(bets, names, extraPubs = []) {
  const pubs = new Set([...Object.keys(names), ...extraPubs]);
  for (const bet of Object.values(bets)) {
    pubs.add(bet.maker);
    pubs.add(bet.taker);
  }
  const stats = {};
  for (const pub of pubs) stats[pub] = { wins: 0, losses: 0, pushes: 0, nets: {}, results: [] };
  const pairWins = {};
  const pairPushes = {};
  const pairNets = {};
  for (const bet of Object.values(bets)) {
    if (bet.status !== "settled" && bet.status !== "push") continue;
    if (bet.maker === bet.taker) continue;
    const key = [bet.maker, bet.taker].sort().join("|");
    pairWins[key] ||= {};
    pairNets[key] ||= {};
    const code = bet.currency.code;
    if (bet.status === "push") {
      for (const pub of [bet.maker, bet.taker]) {
        stats[pub].pushes += 1;
        stats[pub].results.push({ at: bet.settledAt || "", mark: "P" });
      }
      pairPushes[key] = (pairPushes[key] || 0) + 1;
      continue;
    }
    if (bet.winner !== bet.maker && bet.winner !== bet.taker) continue;
    const loser = bet.winner === bet.maker ? bet.taker : bet.maker;
    const stake = loser === bet.maker ? bet.makerStake : bet.takerStake;
    addNet(stats[bet.winner].nets, code, stake);
    addNet(stats[loser].nets, code, -stake);
    stats[bet.winner].wins += 1;
    stats[loser].losses += 1;
    stats[bet.winner].results.push({ at: bet.settledAt || "", mark: "W" });
    stats[loser].results.push({ at: bet.settledAt || "", mark: "L" });
    pairWins[key][bet.winner] = (pairWins[key][bet.winner] || 0) + 1;
    pairNets[key][code] ||= {};
    pairNets[key][code][bet.winner] = (pairNets[key][code][bet.winner] || 0) + stake;
    pairNets[key][code][loser] = (pairNets[key][code][loser] || 0) - stake;
  }
  const leaderboard = [...pubs].map((pub) => {
    const item = stats[pub];
    const decisions = item.wins + item.losses;
    return {
      pub,
      wins: item.wins,
      losses: item.losses,
      pushes: item.pushes,
      winPct: decisions ? item.wins / decisions : null,
      streak: streak(item.results),
      nets: netRows(item.nets, bets),
    };
  }).sort((a, b) => b.wins - a.wins || (b.winPct || 0) - (a.winPct || 0) || nameOf(names, a.pub).localeCompare(nameOf(names, b.pub)));

  const owes = [];
  const pairs = [];
  for (const key of Object.keys({ ...pairWins, ...pairPushes }).sort()) {
    const [a, b] = key.split("|");
    const aWins = pairWins[key]?.[a] || 0;
    const bWins = pairWins[key]?.[b] || 0;
    const pushes = pairPushes[key] || 0;
    if (!aWins && !bWins && !pushes) continue;
    const nets = [];
    for (const code of Object.keys(pairNets[key] || {}).sort()) {
      const minor = pairNets[key][code][a] || 0;
      if (!minor) continue;
      const currency = currencyByCode(bets, code);
      nets.push({ currency, minor });
      owes.push({
        from: minor > 0 ? b : a,
        to: minor > 0 ? a : b,
        currency,
        minor: Math.abs(minor),
      });
    }
    pairs.push({ a, b, aWins, bWins, pushes, nets });
  }
  return { leaderboard, pairs, owes };
}

function apply(names, bets, entry) {
  const key = entry.by;
  if (typeof key !== "string" || !key) return;
  if (entry.type === "profile") {
    try {
      names[key] = assertName(entry.body?.name);
    } catch {
      /* skip a bad name */
    }
    return;
  }
  if (entry.type === "proposal") {
    if (bets[entry.body?.betId]) return;
    try {
      const bet = assertProposal(key, entry.body);
      bets[bet.id] = { ...bet, status: "proposed", winner: null, at: entry.at, settledAt: null };
    } catch {
      /* skip a bet this phone cannot read */
    }
    return;
  }
  const bet = bets[entry.body?.betId];
  if (!bet || (key !== bet.maker && key !== bet.taker)) return;
  if (entry.type === "accept" && bet.status === "proposed" && key === bet.taker) {
    bet.status = "open";
    return;
  }
  if (entry.type === "decline" && bet.status === "proposed" && key === bet.taker) {
    bet.status = "declined";
    bet.settledAt = entry.at;
    return;
  }
  if (entry.type === "withdraw" && bet.status === "proposed" && key === bet.maker) {
    bet.status = "withdrawn";
    bet.settledAt = entry.at;
    return;
  }
  if (entry.type === "note") {
    if (bet.status === "declined" || bet.status === "withdrawn") return;
    if (bet.status === "proposed" && key !== bet.maker) return;
    const note = cleanNote(entry.body?.note);
    if (note != null) bet.note = note;
    return;
  }
  if (entry.type === "settle" && bet.status === "open") {
    const result = entry.body?.result;
    if (result === "maker" || result === "taker") {
      bet.status = "settled";
      bet.winner = result === "maker" ? bet.maker : bet.taker;
      bet.settledAt = entry.at;
    } else if (result === "push" || result === "void") {
      bet.status = result;
      bet.winner = null;
      bet.settledAt = entry.at;
    }
    return;
  }
  if (entry.type === "reopen" && (bet.status === "settled" || bet.status === "push" || bet.status === "void")) {
    bet.status = "open";
    bet.winner = null;
    bet.settledAt = null;
  }
}

function clean(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || [...text].length > limit) return "";
  return text;
}

function cleanNote(value) {
  if (value == null || value === "") return "";
  const text = String(value).trim();
  if ([...text].length > 500) return null;
  return text;
}

function cleanCurrency(value) {
  const code = String(value?.code || "").trim().toUpperCase();
  const name = clean(value?.name, 40);
  const symbol = clean(value?.symbol, 8);
  const decimals = value?.decimals;
  if (!/^[A-Z0-9]{2,8}$/.test(code) || !name || !symbol) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) return null;
  return { code, name, symbol, decimals };
}

function addNet(bucket, code, minor) {
  bucket[code] = (bucket[code] || 0) + minor;
}

function netRows(bucket, bets) {
  return Object.keys(bucket).sort().filter((code) => bucket[code]).map((code) => ({
    code,
    currency: currencyByCode(bets, code),
    minor: bucket[code],
  }));
}

function currencyByCode(bets, code) {
  const found = Object.values(bets).find((bet) => bet.currency.code === code);
  return found?.currency || CURRENCIES[code] || { code, name: code, symbol: code, decimals: 2 };
}

function nameOf(names, pub) {
  return names[pub] || "Unknown";
}

function streak(results) {
  let kind = null;
  let count = 0;
  const ordered = [...results].sort((a, b) => b.at.localeCompare(a.at));
  for (const item of ordered) {
    if (item.mark === "P") continue;
    if (!kind) {
      kind = item.mark;
      count = 1;
      continue;
    }
    if (item.mark !== kind) break;
    count += 1;
  }
  return kind ? `${kind}${count}` : "";
}
