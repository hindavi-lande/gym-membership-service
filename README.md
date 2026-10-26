# gym-membership-service

Baseline Express scaffold for a fitness/gym membership domain: bare-minimum setup with a single `Member` resource and full CRUD, proving the project structure before feature tickets build on top.

## Domain model

- **Member** — firstName, lastName, email (unique, required), phone (optional), membershipPlan (`BASIC` / `STANDARD` / `PREMIUM`, defaults to `BASIC`), status (`ACTIVE` / `INACTIVE` / `SUSPENDED`, defaults to `ACTIVE`), joinedAt (defaults to today), renewalDate (nullable; set to today + 30 days after a successful renewal charge, `null` until then)

## Stack

- Express 4
- Sequelize + SQLite for local dev (swap the dialect in `src/config/database.js` for Postgres/MySQL in other environments)
- helmet, cors, morgan for baseline hardening/logging

## Project structure

```
src/
  config/      # DB connection
  models/      # Sequelize models
  services/    # business logic, DB access
  controllers/ # request/response handling
  routes/      # route definitions
  middleware/  # error handling, 404
  app.js       # express app wiring
  server.js    # entrypoint, DB sync, listen
```

## Run

```
cp .env.example .env
npm install
npm run dev
```

Listens on `http://localhost:3000` (configurable via `PORT`). SQLite file is created at `data/dev.sqlite` on first run.

Renewals and payment history are delegated to a separate `gym-payments-service`, whose base URL is configured via `PAYMENTS_SERVICE_URL` (defaults to `http://localhost:3001`).

> **Note:** this project has no migration tooling — `src/server.js` calls plain `sequelize.sync()`, which does not alter an existing table. If you already have a `data/dev.sqlite` from before `renewalDate` was added, delete it (it is recreated on the next start) so the new column appears.

## Endpoints

- `GET /api/health` — liveness check
- `POST /api/members` — `{ "firstName", "lastName", "email", "phone", "membershipPlan" }` — firstName, lastName, email required; email must be unique
- `GET /api/members` — list all
- `GET /api/members/:id` — get one (`404` if missing)
- `PUT /api/members/:id` — partial update
- `DELETE /api/members/:id`
- `POST /api/members/:id/renew` — renew the member's current plan (no body). Charges the plan's price through `gym-payments-service` and, only on success, sets `renewalDate` to today + 30 days. Responds `402` when the charge is declined, `503` when the payments service is unreachable (in both cases the renewal is **not** applied)
- `GET /api/members/:id/payments` — the member's past renewal charges, proxied as a raw pass-through of the `gym-payments-service` history array (nothing is stored locally; `404` for an unknown member, `503` when the payments service is unreachable)

## Planned tickets (not yet implemented)

1. **Class scheduling** — classes (name, trainer, time slot, capacity) and member bookings against them
2. **Trainer assignment** — round-robin or scoped trainer assignment to classes/members
3. **Attendance check-in** — check-in endpoint tied to a member + class/session, with history
4. **Membership billing follow-ups** — plan pricing tables/plan CRUD, and a reminder/notification hook for upcoming renewals (the renewal charge itself is implemented, see `POST /api/members/:id/renew`)
5. **Search & filtering** — filter members by plan/status, filter classes by trainer/time
