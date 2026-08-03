# RankingShorts Content OS

A hands-off, **self-improving** pipeline for a faceless YouTube Shorts channel
(food / places / countries-to-live rankings). Google Sheets + Apps Script
orchestrator, Claude for writing **and live fact-verification**, ElevenLabs for
voice, **free AI images (Pollinations)** / Pexels / Kling for visuals, Remotion
for assembly, YouTube Data API for upload. Time-based triggers auto-advance every
stage — you don't click through a menu.

## What makes it more than a generator
- **Live fact-verification (Stage 1.5).** Every ranked fact is checked with
  Claude's `web_search` plus a structured knowledge bank (World Bank, WhereNext,
  USDA). **Nothing unverified ever publishes.** Self-healing: a fact it can't
  source is retried with fresh searches over later ticks/days — never
  permanently stuck, never passed unchecked.
- **Coherent rankings.** One clear, instantly-graspable metric per video, sorted
  correctly, with the hook guaranteed to match #1.
- **On-subject visuals.** Default **AI-image** mode generates the actual
  dish/place (free) — stock libraries can't. An **accumulating on-screen
  leaderboard** shows the ranking build up.
- **Self-improving topic picker.** Stage 0 is fed real **YouTube + Google
  trends**, your own **best performers**, and a **hard + semantic dedup** so
  topics never repeat.
- **Learns on its own.** Stage 6 auto-pulls view counts and auto-suggests
  Scale/Hold/Kill, which feeds back into topic selection.

## How it works
```
Google Sheet (dashboard + database)
        │
        ▼
Apps Script (cloud, ticks every 15 min)
  Stage 0    Topic Pick   (Claude + trends + your winners + dedup)
  Stage 1    Script       (Claude — one clear metric, hook = #1)
  Stage 1.5  Verify facts (Claude web_search + knowledge bank; self-healing)
  Stage 2    Visual plan  → 2B fetch (AI image / Pexels / Kling)
  Stage 3    Voiceover    (ElevenLabs, TTS-normalized)
  Stage 4    Assemble     ──► Local Remotion server (your machine, via ngrok)
  Stage 4.5  Metadata     (Claude; sources appended to the description)
  Stage 5    Upload       (YouTube Data API)
  Stage 6    Stats + auto Repeat-decision (YouTube Data API) ──► feeds Stage 0
        │
        ▼
Daily email digest ONLY if something failed — otherwise total silence.

Drive layout:  <production>/<Niche>/<contentId>/   (clips + audio, and final video/)
```

## One-time setup
See `SETUP_CHECKLIST.md` for a tick-box version of everything below.

### 1. Google Sheet + Apps Script
1. Create a new Google Sheet.
2. Extensions → Apps Script. Delete the default `Code.gs`.
3. Copy every file in `/appsscript` into the editor (one Script file per `.js`;
   the `.json` goes in Project Settings → `appsscript.json`, after enabling
   "Show manifest file"). Or use `clasp push` from `/appsscript`.
4. Save, reload the Sheet — a **RankingShorts** menu appears.
5. Run **RankingShorts → Setup & automation → 1. Setup sheets**.

### 2. Script Properties (Project Settings → Script Properties)
| Key | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com (needs the `web_search` tool enabled) |
| `PEXELS_API_KEY` | pexels.com/api |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | elevenlabs.io |
| `YT_CLIENT_ID` / `YT_CLIENT_SECRET` / `YT_REFRESH_TOKEN` | run `node remotion-server/authorize-youtube.js` — it prints all three |
| `DRIVE_FOLDER_ID` | your production folder's ID (same value as the render server's `.env`) |
| `REMOTION_SERVER_URL` | your ngrok URL (set after step 3; re-paste on every ngrok restart) |
| `ALERT_EMAIL` | your email, for the daily error digest |
| `KLING_API_KEY` *(only for Kling video modes)* | kling.ai/dev/api-key (new single-key Bearer format) |
| `YOUTUBE_API_KEY` *(recommended)* | Google Cloud Console → Credentials → API key (YouTube Data API v3). Powers the trend signal **and** the auto-stats/winners loop |
| `USDA_API_KEY` *(optional)* | api.data.gov — enables USDA food-nutrition grounding |

### 3. Local Remotion render server
```bash
cd remotion-server
npm install
```
**One-time Drive authorization** (lets the server upload finished MP4s straight
to Drive, bypassing Apps Script's 50 MB cap):
1. Google Cloud Console → Credentials → OAuth client ID → "Desktop app" →
   download the JSON → save as `remotion-server/oauth-client.json`.
2. `node authorize-drive.js` → open the URL, grant Drive access (saves `drive-token.json`).
3. `node authorize-youtube.js` → grant YouTube access → paste the printed
   `YT_CLIENT_ID` / `YT_CLIENT_SECRET` / `YT_REFRESH_TOKEN` into Script Properties.
4. Copy `.env.template` to `.env` and set `DRIVE_FOLDER_ID`.

Then run it:
```bash
npm start
```
In a second terminal:
```bash
ngrok http 3001
```
Copy the `https://xxxx.ngrok-free.dev` URL into the `REMOTION_SERVER_URL` Script
Property. **This server + ngrok must stay running** for renders to complete —
the one physical thing tying this to your machine. `oauth-client.json`,
`drive-token.json`, and `.env` are gitignored secrets — never commit them.

### 4. Turn it on
**RankingShorts → Setup & automation → 2. Install automation (run once)**.
It now ticks every 15 minutes, refills topics every 6 hours, and runs a daily
maintenance/digest job — all on its own.

## The RankingShorts menu
- **Setup & automation ▸** Setup sheets · Install automation · ⏸ Pause · ▶ Resume
- **▶ Start selected idea** — produce one specific Idea Catalogue row (jumps the queue)
- **▶ Run full tick now**
- **Run one stage ▸** 0 Refill · 1 Script · 1.5 Verify · ↺ Reset failed verifications · 2 Plans · 2B Visuals · 3 Voiceover · 4 Submit · 4B Poll · 4.5 Metadata · 5 Upload · 6 Update view stats
- **Settings ▸** Video mode (none / hero / all / ai-image / ai-image-all) · Kling model (v1 / v2) · Show current settings
- **📊 Show pipeline status** — per-stage counts, trigger state, error count

## Visual modes (`Config.VIDEO_MODE`, or the Settings menu — no code push)
- `ai-image-all` — **default.** FREE Pollinations image of the actual subject, per item.
- `ai-image` — AI image for #1, Pexels for the rest.
- `none` — all Pexels stock (cheapest; weak for named/novelty items).
- `hero` / `all` — Kling AI **video** for #1 / every item (paid ~$0.18/clip, true motion).

## What still needs you (by design)
- Keep the render server + ngrok running (or move `server.js` to a small
  always-on VPS — it runs there unchanged).
- Check the daily error-digest email if one arrives — silence means healthy.
- Optionally override the **auto-suggested** Repeat Decision (Scale/Hold/Kill) in
  the Publishing Tracker; it's auto-filled from view stats, you just fine-tune.

## Tuning (`Config.js`)
- `VIDEOS_PER_DAY` and the trigger interval in `Triggers.js` (`everyMinutes(15)`)
  control throughput.
- `VIDEO_MODE`, `KLING_MODEL` — visual source + model (also live-togglable via the Settings menu).
- `BENCHMARKS` — Scale/Kill thresholds for the winners loop.
- `MAX_VERIFY_ATTEMPTS` — how many fresh-search retries before a script parks for review.
