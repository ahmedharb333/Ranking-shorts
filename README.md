# RankingShorts Content OS

A hands-off pipeline for a faceless YouTube Shorts channel (food / places /
countries-to-live rankings), mirroring the architecture of GovernX
(Google Sheets + Apps Script orchestrator, Claude for writing, ElevenLabs for
voice, Pexels/Kling for visuals, Remotion for assembly, YouTube Data API for
upload) — with one key change: **time-based triggers auto-advance every
stage**, instead of you clicking through a menu.

## How it works

```
Google Sheet (dashboard + database)
        │
        ▼
Apps Script (cloud, runs every 15 min via trigger)
  Stage 0  Topic Pick        (Claude)
  Stage 1  Script            (Claude)
  Stage 2  Visual Plan + Fetch  (Pexels + Kling)
  Stage 3  Voiceover         (ElevenLabs)
  Stage 4  Assembly Submit/Poll  ──────► Local Remotion server (your machine, via ngrok)
  Stage 4.5 YouTube Metadata (Claude)
  Stage 5  Upload            (YouTube Data API)
        │
        ▼
Daily email digest ONLY if something failed — otherwise total silence
```

## One-time setup

### 1. Google Sheet + Apps Script
1. Create a new Google Sheet.
2. Extensions → Apps Script. Delete the default `Code.gs`.
3. Copy every file in `/appsscript` into the Apps Script editor (File → New →
   Script file for each `.js`, paste contents; the `.json` goes in
   Project Settings → `appsscript.json` — enable "Show manifest file" first).
4. Save, reload the Sheet. A **RankingShorts** menu appears.
5. Run **RankingShorts → 1. Setup sheets**.

### 2. API keys (Project Settings → Script Properties)
| Key | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `PEXELS_API_KEY` | pexels.com/api |
| `KLING_API_KEY` | klingai.com developer portal |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | elevenlabs.io |
| `YT_CLIENT_ID` / `YT_CLIENT_SECRET` / `YT_REFRESH_TOKEN` | Google Cloud Console → OAuth (see below) |
| `ALERT_EMAIL` | your email, for the daily error digest |
| `REMOTION_SERVER_URL` | set after step 3 |

**YouTube OAuth refresh token (one-time):** create a project in Google Cloud
Console, enable "YouTube Data API v3", create OAuth Client ID (Desktop app),
then run the standard OAuth consent flow once locally to get a refresh
token — this is the same one-time step GovernX required for its own
YouTube upload stage.

### 3. Local Remotion render server (this replaces GovernX's "I run it
locally" setup — same idea, new composition)
```bash
cd remotion-server
npm install
```

**One-time Drive authorization** (so the server can upload finished MP4s
straight to Drive, bypassing Apps Script's 50MB download cap — same pattern
GovernX uses):
1. Google Cloud Console → Credentials → Create Credentials → OAuth client ID
   → type "Desktop app" → download the JSON → save as `remotion-server/oauth-client.json`.
2. `node authorize-drive.js` → open the printed URL, sign in, grant Drive access.
   Saves `drive-token.json`.
3. Copy `env.template` to `.env` and set `DRIVE_FOLDER_ID` to your production
   folder's ID (from its Drive URL).

Then start the server:
```bash
npm start
```
In a second terminal:
```bash
ngrok http 3000
```
Copy the `https://xxxx.ngrok-free.app` URL into the `REMOTION_SERVER_URL`
Script Property. **This terminal + ngrok need to stay running** for renders
to complete — that's the one physical thing tying this to your machine,
exactly like GovernX. `oauth-client.json` and `drive-token.json` are secrets —
don't commit them if you push this to a repo.

### 4. Turn it on
Run **RankingShorts → 2. Install automation (run once)** from the Sheet menu.
That's it — it now ticks every 15 minutes on its own.

## What still needs you (by design, not by limitation)
- Keeping the Remotion server + ngrok running on your machine (or move it to
  a small always-on VPS later — same server.js works there unchanged).
- Checking the daily error-digest email if one arrives — the pipeline never
  pings you for a healthy run, only for something that needs a fix.
- Periodically filling in `Repeat Decision` (Scale/Hold/Kill) in the
  Publishing Tracker based on real YouTube Analytics, so Stage 0 learns
  which sub-topics to stop generating.

## Adjusting cadence / mix
- `Config.js` → `VIDEOS_PER_DAY` and the trigger interval in `Triggers.js`
  (`everyMinutes(15)`) control throughput. Tighten the interval or raise the
  per-tick stage count to push past 4-5/day once you trust it.
- `Config.js` → `AI_VIDEO_FOR_RANK_1_ONLY` controls the Pexels/Kling mix —
  set to `false` to use Kling for every item (higher cost, more unique look).
