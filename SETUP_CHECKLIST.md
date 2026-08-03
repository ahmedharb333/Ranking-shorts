# RankingShorts — Setup / "Is Everything Armed?" Checklist

Every Script Property and runtime prerequisite to run the pipeline hands-off.
`[x]` = confirmed working; `[ ]` = confirm or still to do.

## 1. Script Properties
Apps Script → ⚙️ **Project Settings** → **Script Properties**.

### Core — required
- [x] `ANTHROPIC_API_KEY` — scripts, fact-verification, metadata
- [x] `PEXELS_API_KEY` — stock visuals
- [x] `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` — voiceover
- [x] `DRIVE_FOLDER_ID` = `1vfKpPeDOiwwPSxE9TKH5Uxs4ftYWaCvG` — production folder (same as render server `.env`)
- [x] `REMOTION_SERVER_URL` — ⚠️ **changes every ngrok restart — re-paste the new https URL each time**
- [ ] `YT_CLIENT_ID` / `YT_CLIENT_SECRET` / `YT_REFRESH_TOKEN` — YouTube upload (Stage 5)
- [ ] `ALERT_EMAIL` — daily error digest

### Feature keys
- [ ] `YOUTUBE_API_KEY` — trend picker + auto-stats/winners loop (YouTube Data API v3 key, read-only)
- [ ] `KLING_API_KEY` — **only if** using a Kling video mode; skip on AI-image/Pexels (new single-key Bearer from kling.ai/dev/api-key)
- [ ] `USDA_API_KEY` — optional; food-nutrition grounding (else web_search covers it)

### Settings — optional (have code defaults; togglable from the menu Settings submenu)
- `VIDEO_MODE` — default `hero` (needs Kling key). Free option: `ai-image-all`. Values: `none | hero | all | ai-image | ai-image-all`
- `KLING_MODEL` — default `kling-v1` (~$0.18/clip). Alt: `kling-v2` (pricier, better)

## 2. Local render machine (keep running while producing)
- [ ] Restart the render server: `cd remotion-server && npm start` (loads latest code)
- [ ] Tunnel: `ngrok http 3001` → paste its https URL into `REMOTION_SERVER_URL`
- [x] `remotion-server/oauth-client.json` + `drive-token.json` present (Drive auth)
- [x] `remotion-server/.env` → `DRIVE_FOLDER_ID` + `PORT=3001`

## 3. One-time Google/Anthropic enables (done)
- [x] Apps Script API (for clasp)
- [x] Drive API (Cloud project)
- [x] YouTube Data API v3
- [x] Anthropic `web_search` tool on the plan (fact-verification)

## 4. Turn it on
- [x] RankingShorts → **1. Setup sheets**
- [ ] RankingShorts → **2. Install automation (run once)** — installs the 15-min tick + 6h topic refill + daily digest triggers

## 5. Confirm it's armed
- [ ] RankingShorts → **📊 Show pipeline status** → "Automation: RUNNING", correct Video mode / Kling model, 0 unresolved errors
- [ ] **Idea Catalogue → ▶ Start selected idea** → watch tabs fill in order (Script Bank → Visual Library → Voiceover Bank → Assembly Tracker → YouTube Metadata → Publishing Tracker) and the **Error Log** stays clean

---

## Menu quick reference (RankingShorts)
- **Setup & automation ▸** Setup sheets · Install automation · ⏸ Pause · ▶ Resume
- **▶ Start selected idea** — produce one specific Idea Catalogue row (jumps the queue)
- **▶ Run full tick now**
- **Run one stage ▸** 0 Refill · 1 Script · 1.5 Verify · 2 Plans · 2B Visuals · 3 Voiceover · 4 Submit · 4B Poll · 4.5 Metadata · 5 Upload · 6 Update view stats
- **Settings ▸** Video mode (None/Hero/All/AI-image/AI-image-all) · Kling model (v1/v2) · Show current settings
- **📊 Show pipeline status**

## The short version — what's actually left
1. Paste `YOUTUBE_API_KEY`
2. Restart the render server + confirm `REMOTION_SERVER_URL` matches current ngrok
3. Confirm `YT_*` upload keys + `ALERT_EMAIL`
4. Run **Install automation** if not already
5. Set `VIDEO_MODE` (`ai-image-all` for free, or a Kling mode + `KLING_API_KEY`)
