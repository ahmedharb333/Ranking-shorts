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
const VIDEOS_PER_DAY = 4;              // mid-point of your 3-5/day target
const MAX_PIPELINE_RUNTIME_PER_TICK_MS = 5 * 60 * 1000; // stay under 6-min Apps Script cap

// ── Google Drive folder structure ─────────────────────────────────────────────
const DRIVE_FOLDER_NAME = "RankingShorts Production";

// ── ElevenLabs API ────────────────────────────────────────────────────────────
const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_MODEL   = "eleven_multilingual_v2";

// ── Pexels API ────────────────────────────────────────────────────────────────
const PEXELS_API_URL = "https://api.pexels.com/videos/search";

// ── Kling / Veo (used only for the #1 "hero" reveal shot per video) ──────────
const KLING_API_URL        = "https://api.klingai.com/v1/videos/text2video";
const KLING_MODEL          = "kling-v2";
const KLING_POLL_INTERVAL  = 15000;
const KLING_MAX_POLLS      = 40;
// Mix-mode rule: item ranks use Pexels; ONLY the #1 reveal scene uses Kling/Veo,
// to control cost while still giving the "wow" hero shot AI video is good for.
const AI_VIDEO_FOR_RANK_1_ONLY = false;

// ── YouTube Data API ──────────────────────────────────────────────────────────
const YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

// ── Performance thresholds (feed the topic picker's Scale/Kill decision) ─────
const BENCHMARKS = {
  RETENTION_SCALE : 50,   // % — Shorts retention to trigger "make more like this"
  VIEWS_24H_KILL  : 300   // views in 24h below which we stop that sub-topic
};

// ── System prompt for script generation (Stage 1) ─────────────────────────────
const SYSTEM_CONTEXT = `You are the content engine for a faceless YouTube Shorts channel
that publishes fast-paced ranking videos across three pillars: best/worst FOOD,
underrated PLACES to visit, and best COUNTRIES to live in.

FORMAT RULES (mandatory):
- Total spoken script: 120-160 words, 30-45 seconds read aloud
- Hook (first 1.5 seconds / first line) must state the single most surprising fact
  or claim in the video, phrased so it works even with sound off (on-screen text
  must carry the same meaning as the spoken hook)
- Structure: Hook → ranked items (usually 5, countdown from #5 to #1, OR build-up
  to #1) → each item gets ONE punchy fact/stat, never generic description →
  closing line that either teases a follow-up or asks a direct question for comments
- No filler phrases ("it's worth noting", "as we can see", "interestingly")
- Every factual claim must be plausible and specific (real cities/countries/dishes,
  real approximate costs or stats) — flag anything you are not confident about
  with [VERIFY] rather than stating it as fact

OUTPUT FORMAT: respond with strict JSON only, matching this shape:
{
  "title": "...",
  "hook": "...",
  "rank_items": [{"rank": 5, "name": "...", "fact": "...", "on_screen_text": "..."}],
  "voiceover_script": "...",
  "cta": "...",
  "duration_target_sec": 38,
  "quality_check": {
    "word_count": 0,
    "hook_works_muted": true,
    "facts_flagged_unverified": []
  }
}`;
