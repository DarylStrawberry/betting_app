const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };
const PREFIX = "MARKER1.";
const SUFFIX = "~END";

export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("That bet has a bad number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  throw new Error("That bet has a value this phone can't sign.");
}

export function bytesToB64url(bytes) {
  let text = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    text += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function b64urlToBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function createIdentity() {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { privateKey: pair.privateKey, pub: bytesToB64url(pub), pkcs8: bytesToB64url(pkcs8) };
}

export async function importPrivate(pkcs8) {
  return crypto.subtle.importKey("pkcs8", b64urlToBytes(pkcs8), ECDSA, true, ["sign"]);
}

export async function importPublic(pub) {
  return crypto.subtle.importKey("raw", b64urlToBytes(pub), ECDSA, true, ["verify"]);
}

export async function signEntry(privateKey, entry) {
  const data = new TextEncoder().encode(canonical(entry));
  const sig = new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, data));
  return { entry, sig: bytesToB64url(sig) };
}

export async function verifyEnvelope(envelope) {
  const entry = envelope?.entry;
  const sig = envelope?.sig;
  if (!entry || entry.v !== 1 || typeof entry.by !== "string" || typeof sig !== "string") return false;
  try {
    const key = await importPublic(entry.by);
    const data = new TextEncoder().encode(canonical(entry));
    return await crypto.subtle.verify(SIGN, key, b64urlToBytes(sig), data);
  } catch {
    return false;
  }
}

export function encodeBundle(entries) {
  const json = JSON.stringify({ v: 1, entries });
  return PREFIX + bytesToB64url(new TextEncoder().encode(json)) + SUFFIX;
}

export function decodeBundle(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("Paste an update first.");
  const squashed = raw.replace(/\s+/g, "");
  let data;
  try {
    const start = squashed.indexOf(PREFIX);
    if (start >= 0) {
      const from = start + PREFIX.length;
      const end = squashed.indexOf(SUFFIX, from);
      const body = end >= 0 ? squashed.slice(from, end) : squashed.slice(from);
      const json = new TextDecoder().decode(b64urlToBytes(body));
      data = JSON.parse(json);
    } else if (raw.includes("{")) {
      data = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    } else {
      throw new Error("That isn't a Marker update.");
    }
  } catch (error) {
    if (error.message === "That isn't a Marker update.") throw error;
    throw new Error("That update is damaged.");
  }
  if (data?.kind === "backup") {
    throw new Error("That is a phone backup. Restore it from Friends, and don't send that file to anyone.");
  }
  if (!data || data.v !== 1 || !Array.isArray(data.entries)) throw new Error("That isn't a Marker update.");
  return data.entries;
}
