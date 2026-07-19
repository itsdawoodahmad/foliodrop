# AI Features — Setup

Folio Drop's PDF tools are still 100% client-side, as before. Two new
features call a small serverless proxy (`api/`) so your Groq/Gemini keys
never reach the browser:

- **✨ AI Summarize** — extracts the PDF's text and asks the AI for a
  short summary plus a suggested filename.
- **✨ AI: Suggest Split Points** (inside the Split tool) — extracts a
  snippet from every page and asks the AI where natural breaks are
  (new chapters, new invoices, etc.), then pre-fills the page ranges.

Both call `POST /api/summarize` and `POST /api/smart-split`, which try
**Groq first, then fall back to Gemini** if Groq is unavailable or
rate-limited. This only works once deployed — opening `index.html`
directly (`file://`) will show a friendly error when an AI button is
clicked, since there's no server to answer `/api/...`.

## Deploy on Vercel

1. Push this folder to a GitHub repo.
2. On [vercel.com](https://vercel.com) → **Add New Project** → import the repo.
   No build configuration is needed — Vercel auto-detects the static
   files plus the `api/` folder.
3. Before (or after) the first deploy: **Settings → Environment Variables**, add:
   - `GROQ_API_KEY`
   - `GEMINI_API_KEY`
   (Either one alone is enough for the AI features to work — the proxy
   skips whichever isn't set. Both configured gives you the fallback.)
4. If you added the variables *after* the first deploy, redeploy once —
   env vars only apply to deployments made after they're set.
5. Done. `yourproject.vercel.app` serves the app; `/api/summarize` and
   `/api/smart-split` are live on the same domain (no CORS setup needed).

## Local testing (optional)

```
npm i -g vercel
cp .env.local.example .env.local   # then fill in your real keys
vercel dev
```

`vercel dev` runs both the static site and the `api/` functions locally.
`.env.local` is already in `.gitignore` — it will never be committed.

## Before you rely on this long-term

Model names on both Groq and Gemini's free tiers change/deprecate over
time. The model IDs in `api/_ai.js` (`GROQ_MODEL`, `GEMINI_MODEL`) are
current as of this writing — check each provider's docs occasionally
and update those two constants if a call starts failing.

## Cost / abuse note

Every visitor who clicks an AI button uses your API quota, not theirs.
Both endpoints already cap the text sent to the AI (~18,000 characters)
to keep individual requests cheap, but there's no per-visitor rate
limit yet. If you share this link publicly, consider adding one (e.g.
via Vercel KV or Upstash Redis) before it gets wide traffic.
