# contact-relay

Cloudflare Worker that receives contact-form POSTs from
[jhomer192.github.io](https://jhomer192.github.io) and pings my Telegram.

No DB, no email. The Telegram message is the notification.

## Deploy

```bash
pnpm install
pnpm wrangler login
pnpm wrangler secret put TELEGRAM_BOT_TOKEN  # paste bot token
pnpm wrangler secret put TELEGRAM_CHAT_ID    # paste numeric chat id
pnpm deploy
```

After deploy, the worker is reachable at `https://contact-relay.<account>.workers.dev`.

## Local dev

```bash
echo 'TELEGRAM_BOT_TOKEN="..."' > .dev.vars
echo 'TELEGRAM_CHAT_ID="..."' >> .dev.vars
pnpm dev
# in another terminal:
curl -X POST http://localhost:8787 \
  -H "content-type: application/json" \
  -d '{"name":"Test","email":"t@t.com","message":"hi"}'
```

## Test

```bash
pnpm test
```
