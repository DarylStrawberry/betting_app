const ISO = new Set(["USD", "VND", "EUR", "GBP", "CAD", "AUD", "JPY", "THB", "MXN"]);

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

export function safeColor(value) {
  return /^#[0-9a-fA-F]{3,8}$/.test(value || "") ? value : "#8a8175";
}

export function formatMoney(amount, currency) {
  const n = Number(amount);
  if (!currency) return String(amount ?? "");
  if (!Number.isFinite(n)) return "";
  if (currency.code === "GOLD") {
    const abs = Math.abs(n);
    const digits = Number.isInteger(abs) ? 0 : Math.min(currency.decimals ?? 2, 2);
    const text = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: currency.decimals ?? 2,
    }).format(abs);
    const body = `${text} ${abs === 1 ? "bar" : "bars"}`;
    return n < 0 ? `−${body}` : body;
  }
  if (ISO.has(currency.code)) {
    const locale = currency.code === "VND" ? "vi-VN" : "en-US";
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.code,
      minimumFractionDigits: currency.decimals,
      maximumFractionDigits: currency.decimals,
    }).format(n);
  }
  const text = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: currency.decimals ?? 2,
  }).format(Math.abs(n));
  const body = `${currency.symbol || ""}${text}`;
  return n < 0 ? `−${body}` : body;
}

export function signedMoney(amount, currency) {
  if (Number(amount) > 0) return `+${formatMoney(amount, currency)}`;
  return formatMoney(amount, currency);
}

export function formatWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

export function dayKey(iso) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayLabel(iso) {
  const date = new Date(iso);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(date);
}

export function ago(iso) {
  if (!iso) return "";
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return "just now";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return formatWhen(iso);
}

export function parseStake(raw, currency) {
  let text = String(raw ?? "").trim().replace(/\s/g, "");
  if (!text) return null;
  const decimals = currency?.decimals ?? 2;
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
  if (!/^\d+(\.\d+)?$/.test(text)) return Number.NaN;
  return Number(text);
}

export function stakeSentence(bet) {
  const yours = formatMoney(bet.makerStake, bet.currency);
  const theirs = formatMoney(bet.takerStake, bet.currency);
  if (Number(bet.makerStake) === Number(bet.takerStake)) {
    return `${bet.maker.name} and ${bet.taker.name} put up ${yours} each. The loser owes that stake.`;
  }
  return `${bet.maker.name} puts up ${yours} against ${bet.taker.name}'s ${theirs}. The loser owes their own stake.`;
}

export function localInputValue(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
