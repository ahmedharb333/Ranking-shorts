/* ============================================================================
   Config.js — RankingShorts Content OS
   Mirrors GovernX's Config.gs conventions, adapted for faceless vertical
   ranking Shorts (food / places / countries-to-live).
   ============================================================================ */

// ── API Constants ─────────────────────────────────────────────────────────────
const ANTHROPIC_MODEL   = "claude-sonnet-5";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// ── Sheet Names ───────────────────────────────────────────────────────────────
const SHEET = {
  IDEA        : "Idea Catalogue",     // topic queue, auto-filled by Stage 0
  SCRIPT      : "Script Bank",        // Stage 1 output
  VISUAL      : "Visual Library",     // Stage 2 output (per-item scene plan)
  AUDIO       : "Voiceover Bank",     // Stage 3 output
  ASSEMBLY    : "Assembly Tracker",   // Stage 4 render job status
  PUBLISHING  : "Publishing Tracker", // Stage 5 output + performance feedback
  YOUTUBE     : "YouTube Metadata",   // Stage 4.5 output
  ERROR_LOG   : "Error Log"
};

// ── Column Indices (1-based) ──────────────────────────────────────────────────

const COL_IDEA = {
  ID              : 1,
  NICHE           : 2,   // Food | Places | Countries
  WORKING_TITLE   : 3,
  ANGLE           : 4,   // e.g. "myth-bust", "countdown", "comparison"
  PRIORITY        : 5,
  STATUS          : 6,   // Queued / In Progress / Done / Skipped
  PIPELINE_STATUS : 7,   // "S1✅ S2✅ S3⏳"
  NOTE            : 8
};

const COL_SCRIPT = {
  ID               : 1,
  NICHE            : 2,
  TITLE            : 3,
  HOOK             : 4,   // first 1.5s line — must work muted
  RANK_ITEMS_JSON  : 5,   // [{rank, name, fact, on_screen_text}] low→high or high→low
  VOICEOVER_SCRIPT : 6,   // full spoken script, ~120-150 words
  CTA              : 7,   // outro line + first-comment prompt
  DURATION_TARGET  : 8,   // seconds, 30-45
  QUALITY_CHECK    : 9,   // raw QA block from Claude
  STATUS           : 10,
  NOTE             : 11
};

const COL_VISUAL = {
  ID            : 1,
  RANK_ITEM_IDX : 2,
  SEARCH_QUERY  : 3,   // Pexels query
  SOURCE        : 4,   // "pexels" | "kling" | "veo"
  CLIP_URL      : 5,   // Drive URL once fetched/generated
  KLING_TASK_ID : 6,
  STATUS        : 7,
  NOTE          : 8
};

const COL_AUDIO = {
  ID          : 1,
  RANK_ITEM_IDX: 2,   // 0 = hook/intro, 1..N = each ranked item, 99 = outro
  AUDIO_URL   : 3,    // Drive URL, ElevenLabs mp3
  DURATION_SEC: 4,
  STATUS      : 5
};

const COL_ASSEMBLY = {
  ID           : 1,
  JOB_ID       : 2,
  SUBMITTED_AT : 3,
  STATUS       : 4,   // queued / rendering / done / error
  MP4_URL      : 5,   // Drive URL of finished vertical video
  NOTE         : 6
};

const COL_YOUTUBE = {
  ID             : 1,
  TITLE_A        : 2,
  TITLE_B        : 3,
  DESCRIPTION    : 4,
  TAGS           : 5,
  HASHTAGS       : 6,
  FIRST_COMMENT  : 7,
  THUMBNAIL_BRIEF: 8,
  STATUS         : 9
};

const COL_PUBLISHING = {
  ID               : 1,
  PUBLISH_DATE     : 2,
  YOUTUBE_VIDEO_ID : 3,
  VIEWS_24H        : 4,
  VIEWS_7D         : 5,
  RETENTION        : 6,
  REPEAT_DECISION  : 7,   // Scale / Hold / Kill — feeds back into Stage 0 topic picker
  NOTE             : 8
};

const COL_ERROR = {
  TIMESTAMP  : 1,
  STAGE      : 2,
  ID         : 3,
  ERROR_TYPE : 4,
  DETAILS    : 5,
  RESOLVED   : 6
};

// ── Niches (rotate to keep one channel, three content pillars) ───────────────
const NICHES = ["Food", "Places", "Countries"];

// ── Automation cadence ────────────────────────────────────────────────────────
// Daily output = DAILY_TOPICS_PER_NICHE × number of niches. With 2 and the 3
// pillars (Food/Places/Countries), that's a hard 6 videos/day. Stage 0 counts
// each niche's topics created today (by ID date) and stops at the quota.
const DAILY_TOPICS_PER_NICHE = 2;
const MAX_PIPELINE_RUNTIME_PER_TICK_MS = 5 * 60 * 1000; // stay under 6-min Apps Script cap

// Spaced publishing: each upload is scheduled to go LIVE at the next free slot
// (local / script timezone) instead of all at once — better for the algorithm.
// One slot per expected daily video. Empty array [] = publish immediately.
const PUBLISH_SLOTS = ["09:00", "11:30", "14:00", "16:30", "19:00", "21:30"];

// ── Google Drive folder structure ─────────────────────────────────────────────
// All of a video's files live under one per-video folder named by its ID:
//   <DRIVE_FOLDER_ID>/<contentId>/            clips + audio  (Apps Script)
//   <DRIVE_FOLDER_ID>/<contentId>/final video/<contentId>.mp4  (render server)
// DRIVE_FOLDER_ID is a Script Property (same value as the render server's .env),
// read via getProductionFolder_() in Visuals.js.

// ── ElevenLabs API ────────────────────────────────────────────────────────────
const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_MODEL   = "eleven_multilingual_v2";
// Punchy, energetic delivery for fast ranking Shorts: lower stability = more
// dynamic/expressive; style adds emphasis; speaker_boost sharpens presence.
// Tune these to taste — they're passed on every TTS call.
const ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.35,
  similarity_boost: 0.8,
  style: 0.45,
  use_speaker_boost: true
};

// ── Pexels API ────────────────────────────────────────────────────────────────
const PEXELS_API_URL = "https://api.pexels.com/videos/search";

// ── Kling / Veo (used only for the #1 "hero" reveal shot per video) ──────────
const KLING_API_URL        = "https://api.klingai.com/v1/videos/text2video";
const KLING_MODEL_DEFAULT   = "kling-v1"; // fallback; override live via menu (Script Property KLING_MODEL). ~$0.18/5s clip.
function getKlingModel_() {
  return PropertiesService.getScriptProperties().getProperty("KLING_MODEL") || KLING_MODEL_DEFAULT;
}
const KLING_POLL_INTERVAL  = 15000;
const KLING_MAX_POLLS      = 40;
// Visual source mode — controls the Pexels/Kling mix:
//   "none" — every item uses Pexels stock (cheapest; weak for luxury/novelty items)
//   "hero" — Kling AI video for #1 only, Pexels for the rest (balanced; the #1
//            "wow" reveal is AI-generated so it can match a specific/luxury item)
//   "all"  — Kling AI video for EVERY item (most unique look + best match for
//            hard-to-stock topics; highest cost + slowest, all clips are async)
// Fallback default; override live via menu (Script Property VIDEO_MODE).
// "ai-image-all": every item gets a free Pollinations image of the ACTUAL
// subject — reliable relevance for food/niche topics stock libraries can't cover.
const VIDEO_MODE_DEFAULT = "ai-image-all";
// Modes: "none" (all Pexels) | "hero"/"all" (Kling AI video for #1 / every item)
//        | "ai-image"/"ai-image-all" (FREE Pollinations AI image + Ken Burns
//        zoom for #1 / every item — no key, no cost, good for hard-to-stock subjects)
function getVideoMode_() {
  const v = PropertiesService.getScriptProperties().getProperty("VIDEO_MODE");
  const valid = { "none": 1, "hero": 1, "all": 1, "ai-image": 1, "ai-image-all": 1 };
  return valid[v] ? v : VIDEO_MODE_DEFAULT;
}

// ── YouTube Data API ──────────────────────────────────────────────────────────
const YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

// ── Performance thresholds (feed the topic picker's Scale/Kill decision) ─────
const BENCHMARKS = {
  RETENTION_SCALE : 50,     // % — Shorts retention to trigger "make more like this"
  VIEWS_7D_SCALE  : 5000,   // views in 7d above which a topic counts as a "winner"
  VIEWS_24H_KILL  : 300     // views in 24h below which we stop that sub-topic
};

// Verification retries with FRESH web searches before parking a script for
// review — keeps the check tight (nothing unverified ever passes) without one
// hard topic looping forever and burning API cost.
const MAX_VERIFY_ATTEMPTS = 3;

// ── System prompt for script generation (Stage 1) ─────────────────────────────
const SYSTEM_CONTEXT = `You are the content engine for a faceless YouTube Shorts channel
that publishes fast-paced ranking videos across three DISTINCT pillars:

- FOOD — best/worst dishes, cuisines, restaurants, food prices. Ranked items are
  foods or food-related, never destinations.
- PLACES — underrated spots to VISIT (short-term travel). Ranked items are
  sub-national ONLY: cities, towns, neighborhoods, islands, regions, or specific
  attractions. NEVER a whole country. Judge by the travel experience/value of
  going there.
- COUNTRIES — best whole NATIONS to LIVE in / relocate to (long-term). Ranked
  items are entire countries ONLY. Judge by cost of living, residency/visas,
  retirement, taxes, quality of life — NOT by tourism.

PILLAR SEPARATION (mandatory): Places and Countries must never overlap. If the
niche is PLACES, every ranked item must be a city/town/region/island/attraction
and it is an error to rank a whole country. If the niche is COUNTRIES, every
ranked item must be an entire country and it is an error to rank a city or region.

ANGLES (each video has one):
- countdown — rank items #5→#1 by an objective measure (price, heat, cost, etc.).
- comparison — head-to-head between options on concrete criteria.
- myth-bust — correct a common misconception with facts.
- perspective — a SUBJECTIVE, personal take ("this is what I see — no right or
  wrong"). Frame it openly as opinion ("my pick", "hear me out", "in my view").
  Rank by personal preference, NOT objective truth, and never present a subjective
  preference as an established fact. Any concrete claim you DO make (a price, date,
  law, record) must still be true and specific.

FORMAT RULES (mandatory):
- Total spoken script: 120-160 words, 30-45 seconds read aloud
- RANKING METRIC: choose exactly ONE metric a viewer grasps INSTANTLY — a single
  concrete dimension like price ($), spiciness (Scoville), size/weight, rarity,
  age, or wait time. NEVER use an abstract or COMPOUND metric (e.g. "calories per
  dollar", "value score", "X per Y") — if a viewer can't tell in one second what
  is being ranked, pick a different metric. Sort EVERY item by it consistently;
  #1 is the extreme end (the highest / most). Each item's "fact" states that
  item's value for the metric with a specific number, so the numbers never
  contradict the rank order (a lower-ranked item must not out-number #1).
- HOOK (first 1.5s / first line): state the single most surprising fact, and it
  MUST be about the #1 item. The headline number in the hook must EQUAL the #1
  item's metric value (or another number that actually appears in the ranking).
  NEVER promise a number that no ranked item delivers. It must work with sound
  off (on-screen text carries the same meaning as the spoken hook).
- ON-SCREEN TEXT (on_screen_text): show ONLY that item's metric value with its
  unit — nothing else. No item name, no filler words, no trailing clause. Max 4
  words. GOOD: "$12,195 / month", "2.2M SHU", "$50 / lb", "1,200 years old".
  BANNED: "$1,000/month required", "$157 a night, nightlife", "$50/lb Horse
  Cheese", "$1,000/month in Thailand" — the metric is a clean number + unit only.
- Structure: Hook → ranked items (5, countdown #5→#1) → each item gets ONE punchy
  fact = its metric value, never generic description → closing line that teases a
  follow-up or asks a direct question for comments
- VISUAL QUERY: every ranked item needs a "search_query" — a clean 3-6 word
  description of the ACTUAL thing to show on screen, for stock footage / AI image
  generation. LEAD with the literal core noun, then 1-2 descriptors, so the image
  is unmistakably that item. Map any named/brand item to its generic form. NO
  numbers, NO units, NO obscure brand names (stock has no footage of them and
  numbers mislead the search — "peak" once returned a mountain).
  E.g. "Pepper X Wings" -> "chicken wings, fiery red sauce, close-up";
  "Tonkotsu Ramen" -> "ramen bowl, pork broth, close-up";
  "Chiado, Lisbon" -> "Chiado Lisbon plaza, historic tram".
  DISTINCTNESS (critical): the five queries must be VISUALLY DIFFERENT from each
  other — key each on that item's most ICONIC, recognizable landmark or defining
  feature so no two scenes look alike. Never reuse a generic backdrop (a plain
  "narrow street", "city skyline") across multiple items; if two items would look
  the same on camera, pick a more specific defining subject for each.
- No filler phrases ("it's worth noting", "as we can see", "interestingly")
- Every factual claim must be plausible and specific (real cities/countries/dishes,
  real approximate costs or stats) — flag anything you are not confident about
  with [VERIFY] rather than stating it as fact

OUTPUT FORMAT: respond with strict JSON only, matching this shape:
{
  "title": "...",
  "hook": "...",
  "rank_items": [{"rank": 5, "name": "...", "fact": "...", "on_screen_text": "...", "search_query": "..."}],
  "voiceover_script": "...",
  "cta": "...",
  "duration_target_sec": 38,
  "quality_check": {
    "word_count": 0,
    "hook_works_muted": true,
    "ranking_metric": "the single metric used to sort, e.g. price in USD",
    "sorted_by_metric": true,
    "hook_number_matches_rank1": true,
    "facts_flagged_unverified": []
  }
}`;
