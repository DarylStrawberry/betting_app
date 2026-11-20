# Dead Money

The phone book for bets between friends. Each phone keeps its own signed copy. A bet counts when the other phone accepts it. You pass that update in a message.

This app does not hold money, move money, or pay anyone out. The computer book stays in `betting_app`.

```bash
npm install
npm start
npm run typecheck
```

Create a book with the name your friends use. Copy or share the update, and paste theirs back. Dollars, dong, gold bars, euro, and pounds are built in. Any other unit can be added on the bet.

A backup file can sign bets as you. Keep it private. Do not send it as an update.

The update text uses the same `MARKER1.` envelope as the web phone at `betting_app/web/phone`, so the two can exchange bets.
