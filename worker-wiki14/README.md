# wiki14 Gemini proxy (Cloudflare Worker)

Holds the Gemini API key server-side. The static site calls this instead of
Gemini directly, so the key never reaches any browser.

## Deploy

```bash
npm install -g wrangler   # if you don't have it already
cd worker
wrangler login
wrangler secret put GEMINI_API_KEY     # paste your Gemini key when prompted
wrangler secret put APP_TOKEN          # invent any random string, e.g. `openssl rand -hex 16`
wrangler deploy
```

`wrangler deploy` prints your Worker's URL, something like
`https://wiki14-gemini-proxy.YOUR-SUBDOMAIN.workers.dev`.

## Configure

Two places need updating with values from your deploy:

1. **`worker/index.js`** — set `ALLOWED_ORIGIN` at the top to your GitHub
   Pages URL (e.g. `https://your-username.github.io`), then `wrangler deploy`
   again.
2. **`site/app.js`** — set `CONFIG.workerUrl` to the Worker URL above, and
   `CONFIG.appToken` to the same random string you used for `APP_TOKEN`.

## Why the APP_TOKEN

It's not a real secret — it ships inside the public site's JS, same as
`workerUrl`. It's just a speed bump so a stranger who stumbles on your
Worker's URL (e.g. via a leaked link) can't casually send it requests and
burn your Gemini quota. If this ever becomes an actual concern, pair it with
Cloudflare's built-in rate-limiting rules on the Worker route.

## What this Worker does and doesn't see

- Receives: an EN style-run summary (style label + paragraph range + text)
  and a target language's paragraph list.
- Sends to Gemini: a prompt asking it to resolve paragraph-range boundaries
  for each style label, with structured JSON output.
- Returns: the JSON match result to the site.

It's called rarely — only when a language's paragraph count doesn't match
the EN sourcecode's (translator merged/split content differently), which in
testing was 1 language out of 13 on a real page. Most runs won't call it at
all.
