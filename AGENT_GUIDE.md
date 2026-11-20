# Agent guide

Dead Money is the phone book. The server and the browser page stay in `C:\Users\dbart\Dev\betting_app`. Do not reimplement filing math, and do not call ESPN from this app.

## Rules

- Route files in `src/app` only render a screen from `src/features/book`.
- Screens do not call `fetch`. This book has no server. Signing and the ledger live in `src/features/book/services`.
- Keep the entry format compatible with `betting_app/web/phone`: canonical JSON, ECDSA P-256, SHA-256, raw public keys, PKCS8 private keys, and `MARKER1.` bundles.
- The private key stays in secure storage. An update bundle must not contain it. A backup file may, and Friends is the only place that reads a backup.
- Stake amounts inside an entry are minor units. Display code converts them.
- A proposal does not change the record until the taker accepts it.

## Commands

From this directory:

```bash
npm start
npm run typecheck
npx expo install <package>
```

## Layout

```text
src/app/setup.tsx          first run, name and key
src/app/(book)/            board, history, records, friends, new bet, bet detail
src/features/book/services ledger, format, crypto, book store
src/core                   theme, storage, toasts
```

`src/core/theme/app.theme.ts` holds the paper and green palette. Change it there.
