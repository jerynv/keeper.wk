# keeper.wk

A self-hostable [keeper.sh](https://github.com/ridafkih/keeper.sh) that runs entirely on Cloudflare Workers. It keeps your calendars in sync around the clock, with nothing running on your own machine.

It's a fork of keeper.sh cut down to one person. The sync engine and the dashboard are keeper.sh's. Everything around them was rebuilt for Workers:

| keeper.sh | keeper.wk |
|---|---|
| Postgres | D1 |
| Redis, BullMQ, cron and worker services | a Cron Trigger every minute, and a Queue with one message per calendar |
| better-auth, sign-up, sessions | Cloudflare Access in front, with its JWT checked in the Worker on every request |
| API service and SSR web server | the Worker answers `/api` and serves the dashboard as static assets |
| billing, plans, feedback, MCP | gone, and everything is unlocked |

Supported: Google Calendar, iCloud, Fastmail, any CalDAV server, and ICS/webcal feeds as sources. Outlook is in the code but not wired up.

## The one rule

keeper.wk only ever changes or deletes events it created. Every delete has to be backed by both the `@keeper.sh` marker on the event and a mapping row recording that this instance pushed it. An event you made by hand is never touched. Neither is a copy pushed by some other Keeper instance into the same calendar. If you run two Keeper instances against one calendar, though, the other one may not be as careful.

## Deploying

You need a Cloudflare account on Workers Paid, a domain on Cloudflare, and Zero Trust enabled (the free plan is fine).

```sh
bun install
cd packages/worker

npx wrangler d1 create keeper-cf          # put the database_id into wrangler.jsonc
npx wrangler queues create keeper-sync
npx wrangler d1 migrations apply keeper-cf --remote

openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put GOOGLE_CLIENT_ID      # optional, for Google
npx wrangler secret put GOOGLE_CLIENT_SECRET

(cd ../../applications/web && bun run build)
npx wrangler deploy
```

Then in `wrangler.jsonc` set your route and these vars, and deploy again:

- `PUBLIC_ORIGIN`: your hostname, for example `https://cal.example.com`
- `ACCESS_TEAM_DOMAIN`: `https://<team>.cloudflareaccess.com`
- `ACCESS_AUD`: the Application Audience tag of the Access app below
- `OWNER_EMAIL`: the one email allowed in
- `SOURCE_URL`: where your copy of the source lives (AGPL-3.0 section 13)
- `TIMEZONE`: optional

**Access.** In Zero Trust, add a self-hosted application for your hostname, with a policy that allows only your email. The Worker refuses every request whose Access token doesn't verify against your team's keys, isn't for that application, or isn't for `OWNER_EMAIL`. If any of those settings are missing, it refuses everything.

**Google.**
1. In Google Cloud, enable the Google Calendar API.
2. Create an OAuth client of type "Web application" with this redirect URI: `https://<your host>/api/sources/callback/google`.
3. On the consent screen, set publishing status to **In production**. While it's on **Testing**, Google expires refresh tokens after 7 days.

## Secrets

OAuth tokens and CalDAV passwords are encrypted in D1 with `ENCRYPTION_KEY` (NaCl secretbox). If you rotate the key, every stored credential stops decrypting, so reconnect your accounts afterwards. Google client secrets can be rotated freely with `wrangler secret put`.

## Rolling back

`npx wrangler deployments list`, then `npx wrangler rollback <version-id>`. The migrations only ever add tables, so an older Worker still runs against a newer database.

## Developing

```sh
bun run test     # every suite runs inside workerd against a local D1
bun run types
bun run lint
cd packages/worker && npx wrangler dev --test-scheduled
```

`/__scheduled` triggers the cron by hand in `wrangler dev`.

## License

AGPL-3.0, same as keeper.sh. See `LICENSE` and `NOTICE`.
