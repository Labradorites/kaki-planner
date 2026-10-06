# Kaki Planner

A planner for a small group of friends that handles dates and money.

- **Login:** each friend signs up with a username and password. Passwords are hashed with scrypt, and the login cookie lasts 30 days.
- **Scheduler:** you create an outing or trip with a date window, a length in days and the friends you're inviting. Each person taps the days they can't make it. The app suggests the earliest block where everyone is free. If no block works for everyone, it suggests the block with the fewest clashes and names who can't come. Until everyone has responded (by marking days or tapping "I'm free on all days"), the suggestion is labelled "Best so far" and the app lists who it's still waiting on.
- **Expenses:** each expense records the item, the amount, the currency, who paid and who it's split equally between. Foreign currencies are converted to the event's main currency at a rate you enter, and the app remembers the last rate used for each currency. The settle-up section shows the fewest transfers needed to clear all debts.

## Run
`node server.js`, then open http://localhost:3000. It needs Node 22.13+ for the built-in `node:sqlite`. No `npm install` is needed.

Data is saved in `kaki.db`. You can set `PORT` and `DB_FILE` to change the port and the database file.

For friends to use it, deploy it somewhere with a persistent disk (e.g. Render or Railway with a volume, and `DB_FILE` pointing to that volume). On a LAN, they can open `http://<your-ip>:3000`.
