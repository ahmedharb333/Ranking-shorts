/* ============================================================================
   YouTube_Upload.js — RankingShorts Content OS
   Stage 4.5: Claude writes title/description/tags/hashtags/first-comment.
   Stage 5: uploads the finished MP4 (from Assembly Tracker) via YouTube
   Data API v3, using a stored OAuth refresh token (see README for one-time
   setup) — no human click required after that.
   ============================================================================ */

function stage4_5_generateYoutubeMetadata(scriptId) {
  const scriptRow = findRowById_(SHEET.SCRIPT, scriptId, COL_SCRIPT.ID);
  const prompt = "Write YouTube Shorts metadata for this ranking video.\n" +
    "Title: " + scriptRow[COL_SCRIPT.TITLE - 1] + "\n" +
    "Hook: " + scriptRow[COL_SCRIPT.HOOK - 1] + "\n" +
    "Script: " + scriptRow[COL_SCRIPT.VOICEOVER_SCRIPT - 1] + "\n\n" +
    "Return strict JSON: {\"title_a\":\"\",\"title_b\":\"\",\"description\":\"\",\"tags\":\"\",\"hashtags\":\"\",\"first_comment\":\"\",\"thumbnail_brief\":\"\"}";

  try {
    const raw = callClaude(prompt, "stage4_metadata");
    const parsed = parseClaudeJson(raw);
    const description = parsed.description + buildSourcesBlock_(scriptRow);
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.YOUTUBE);
    sh.appendRow([scriptId, parsed.title_a, parsed.title_b, description,
      parsed.tags, parsed.hashtags, parsed.first_comment, parsed.thumbnail_brief, "Ready"]);
    return true;
  } catch (err) {
    logError("Stage 4.5 — YouTube Metadata", scriptId, "API Error", err.message);
    return false;
  }
}

// Builds a "Sources" section from the verified rank items (each carries a
// source URL from Stage 1.5). Returns "" if no sources are present.
function buildSourcesBlock_(scriptRow) {
  let items;
  try { items = JSON.parse(scriptRow[COL_SCRIPT.RANK_ITEMS_JSON - 1]); }
  catch (e) { return ""; }
  const lines = (items || [])
    .filter(function (it) { return it && it.source; })
    .map(function (it) { return "#" + it.rank + " " + it.name + ": " + it.source; });
  if (!lines.length) return "";
  return "\n\nSources:\n" + lines.join("\n");
}

// ── STAGE 5 — Upload ──────────────────────────────────────────────────────────
// Next free publish slot as a Date (script timezone), or null if scheduling is
// off (empty PUBLISH_SLOTS). Skips past/too-soon slots and any already booked.
function nextPublishSlot_() {
  if (!PUBLISH_SLOTS || !PUBLISH_SLOTS.length) return null;
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const bufferMs = 15 * 60 * 1000;                     // publishAt must be safely in the future
  const offset = Utilities.formatDate(now, tz, "XXX"); // e.g. "+03:00"

  const pub = SpreadsheetApp.getActive().getSheetByName(SHEET.PUBLISHING);
  const taken = pub ? pub.getDataRange().getValues().slice(1)
    .map(function (r) { return r[COL_PUBLISHING.PUBLISH_DATE - 1]; })
    .filter(function (d) { return d instanceof Date; })
    .map(function (d) { return d.getTime(); }) : [];

  for (var day = 0; day < 5; day++) {
    const dateStr = Utilities.formatDate(new Date(now.getTime() + day * 86400000), tz, "yyyy-MM-dd");
    for (var s = 0; s < PUBLISH_SLOTS.length; s++) {
      const slot = new Date(dateStr + "T" + PUBLISH_SLOTS[s] + ":00" + offset);
      if (slot.getTime() < now.getTime() + bufferMs) continue;
      const clash = taken.some(function (t) { return Math.abs(t - slot.getTime()) < 60000; });
      if (!clash) return slot;
    }
  }
  return null;
}

// Returns a summary {done, uploaded, alreadyPublished, noMetadata, errors} so the
// menu can report what happened (the tick ignores the return value).
function stage5_uploadReadyVideos() {
  const assemblySh = SpreadsheetApp.getActive().getSheetByName(SHEET.ASSEMBLY);
  const rows = assemblySh.getDataRange().getValues();
  const summary = { done: 0, uploaded: 0, alreadyPublished: 0, noMetadata: 0, errors: 0 };

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][COL_ASSEMBLY.STATUS - 1] !== "done") continue;
    summary.done++;
    const scriptId = rows[i][COL_ASSEMBLY.ID - 1];
    const mp4Url = rows[i][COL_ASSEMBLY.MP4_URL - 1];

    if (findRowById_(SHEET.PUBLISHING, scriptId, COL_PUBLISHING.ID)) { summary.alreadyPublished++; continue; }

    const meta = findRowById_(SHEET.YOUTUBE, scriptId, COL_YOUTUBE.ID);
    if (!meta) { summary.noMetadata++; continue; } // Stage 4.5 hasn't run yet for this one

    try {
      const slot = nextPublishSlot_(); // scheduled go-live time (or null = publish now)
      const videoId = uploadToYoutube_(mp4Url, meta, slot ? slot.toISOString() : null, scriptId);
      SpreadsheetApp.getActive().getSheetByName(SHEET.PUBLISHING)
        .appendRow([scriptId, slot || new Date(), videoId, "", "", "", "", ""]);
      summary.uploaded++;
    } catch (err) {
      summary.errors++;
      logError("Stage 5 — Upload", scriptId, "Upload Error", err.message);
    }
  }
  return summary;
}

// ── STAGE 6 — Auto-fetch view stats ──────────────────────────────────────────
// Fills the Publishing Tracker's Views 24h / Views 7d from the YouTube Data API
// so the Stage 0 "winners" loop learns automatically. Snapshots each metric once
// its age window is reached; never overwrites an existing value. Retention is
// not in the public Data API — leave that column for manual/Analytics entry.
function stage6_updatePublishingStats() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.PUBLISHING);
  if (!sh) return;
  fetchPublishingViews_(sh);      // auto-fill Views 24h/7d from the Data API
  suggestRepeatDecisions_(sh);    // auto-suggest Scale/Hold/Kill from the data
}

function fetchPublishingViews_(sh) {
  const key = PropertiesService.getScriptProperties().getProperty("YOUTUBE_API_KEY");
  if (!key) return; // needs a Data API key (same one the trend picker uses)
  const data = sh.getDataRange().getValues();
  const now = Date.now();

  const need = [];
  for (let i = 1; i < data.length; i++) {
    const videoId = data[i][COL_PUBLISHING.YOUTUBE_VIDEO_ID - 1];
    if (!videoId) continue;
    const pub = data[i][COL_PUBLISHING.PUBLISH_DATE - 1];
    const ageH = pub ? (now - new Date(pub).getTime()) / 3600000 : 0;
    const want24h = !data[i][COL_PUBLISHING.VIEWS_24H - 1] && ageH >= 24;
    const want7d  = !data[i][COL_PUBLISHING.VIEWS_7D - 1]  && ageH >= 168;
    if (want24h || want7d) need.push({ row: i + 1, videoId: videoId, want24h: want24h, want7d: want7d });
  }
  if (!need.length) return;

  const stats = {};
  for (let s = 0; s < need.length; s += 50) { // Data API allows up to 50 ids/call
    const ids = need.slice(s, s + 50).map(function (n) { return n.videoId; }).join(",");
    try {
      const url = "https://www.googleapis.com/youtube/v3/videos?part=statistics&id=" +
        encodeURIComponent(ids) + "&key=" + key;
      const json = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText());
      (json.items || []).forEach(function (it) {
        stats[it.id] = it.statistics ? Number(it.statistics.viewCount) : null;
      });
    } catch (e) {
      logError("Stage 6 — Stats", ids.slice(0, 40), "Stats Error", e.message);
    }
  }

  need.forEach(function (n) {
    const views = stats[n.videoId];
    if (views == null || isNaN(views)) return;
    if (n.want24h) sh.getRange(n.row, COL_PUBLISHING.VIEWS_24H).setValue(views);
    if (n.want7d)  sh.getRange(n.row, COL_PUBLISHING.VIEWS_7D).setValue(views);
  });
}

// Auto-suggests a Repeat Decision from the numbers, ONLY for rows the user
// hasn't decided yet (never overwrites a manual call). Marked "(auto-suggested)"
// in the Note so it's clearly a starting point you can change.
//   Kill  — 24h views below VIEWS_24H_KILL (a dead Short)
//   Scale — 7d views clear VIEWS_7D_SCALE, or retention clears RETENTION_SCALE
//   Hold  — matured (>=7d) without hitting either bar
function suggestRepeatDecisions_(sh) {
  const data = sh.getDataRange().getValues();
  const now = Date.now();
  for (let i = 1; i < data.length; i++) {
    if (!data[i][COL_PUBLISHING.ID - 1]) continue;
    if (data[i][COL_PUBLISHING.REPEAT_DECISION - 1]) continue; // respect an existing/manual decision

    const pub = data[i][COL_PUBLISHING.PUBLISH_DATE - 1];
    const ageH = pub ? (now - new Date(pub).getTime()) / 3600000 : 0;
    const has24 = data[i][COL_PUBLISHING.VIEWS_24H - 1] !== "" && data[i][COL_PUBLISHING.VIEWS_24H - 1] != null;
    const has7  = data[i][COL_PUBLISHING.VIEWS_7D - 1] !== "" && data[i][COL_PUBLISHING.VIEWS_7D - 1] != null;
    const v24 = Number(data[i][COL_PUBLISHING.VIEWS_24H - 1]) || 0;
    const v7  = Number(data[i][COL_PUBLISHING.VIEWS_7D - 1]) || 0;
    const ret = Number(data[i][COL_PUBLISHING.RETENTION - 1]) || 0;

    let decision = "";
    if (has24 && ageH >= 24 && v24 < BENCHMARKS.VIEWS_24H_KILL) decision = "Kill";
    else if ((has7 && v7 >= BENCHMARKS.VIEWS_7D_SCALE) || ret >= BENCHMARKS.RETENTION_SCALE) decision = "Scale";
    else if (has7 && ageH >= 168) decision = "Hold";

    if (decision) {
      sh.getRange(i + 1, COL_PUBLISHING.REPEAT_DECISION).setValue(decision);
      const note = data[i][COL_PUBLISHING.NOTE - 1];
      sh.getRange(i + 1, COL_PUBLISHING.NOTE).setValue((note ? note + " " : "") + "(auto-suggested)");
    }
  }
}

// Adds the uploaded video to its niche playlist. Playlist IDs live in Script
// Properties PLAYLIST_FOOD / PLAYLIST_PLACES / PLAYLIST_COUNTRIES. No-op if the
// niche's property isn't set. Needs the youtube.force-ssl scope (already granted).
function addToNichePlaylist_(videoId, contentId, accessToken) {
  const niche = String(contentId || "").split("-")[0].toUpperCase(); // FOOD / PLACES / COUNTRIES
  const playlistId = PropertiesService.getScriptProperties().getProperty("PLAYLIST_" + niche);
  if (!playlistId) return;
  UrlFetchApp.fetch("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + accessToken },
    payload: JSON.stringify({
      snippet: { playlistId: playlistId, resourceId: { kind: "youtube#video", videoId: videoId } }
    }),
    muteHttpExceptions: true
  });
}

function uploadToYoutube_(driveMp4Url, meta, publishAtIso, contentId) {
  const accessToken = getYoutubeAccessToken_();
  const fileId = extractDriveFileId_(driveMp4Url);
  const fileBlob = DriveApp.getFileById(fileId).getBlob();

  // Scheduled: upload private with a publishAt (YouTube auto-publishes then).
  // Otherwise go public immediately.
  const status = publishAtIso
    ? { privacyStatus: "private", publishAt: publishAtIso, selfDeclaredMadeForKids: false }
    : { privacyStatus: "public", selfDeclaredMadeForKids: false };

  const metadata = {
    snippet: {
      title: meta[COL_YOUTUBE.TITLE_A - 1],
      description: meta[COL_YOUTUBE.DESCRIPTION - 1] + "\n\n" + meta[COL_YOUTUBE.HASHTAGS - 1],
      tags: (meta[COL_YOUTUBE.TAGS - 1] || "").split(",").map(function (t) { return t.trim(); })
    },
    status: status
  };

  const boundary = "-------rankingshorts" + Utilities.getUuid();
  const metaPart = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) + "\r\n";
  const videoPartHeader = "--" + boundary + "\r\nContent-Type: video/mp4\r\n\r\n";
  const closing = "\r\n--" + boundary + "--";

  const payload = Utilities.newBlob(metaPart).getBytes()
    .concat(Utilities.newBlob(videoPartHeader).getBytes())
    .concat(fileBlob.getBytes())
    .concat(Utilities.newBlob(closing).getBytes());

  const res = UrlFetchApp.fetch(
    YOUTUBE_UPLOAD_URL + "?uploadType=multipart&part=snippet,status", {
      method: "post",
      contentType: "multipart/related; boundary=" + boundary,
      headers: { Authorization: "Bearer " + accessToken },
      payload: payload,
      muteHttpExceptions: true
    });

  const data = JSON.parse(res.getContentText());
  if (!data.id) throw new Error("YouTube upload failed: " + res.getContentText().slice(0, 400));

  // Pin first comment
  try {
    postFirstComment_(accessToken, data.id, meta[COL_YOUTUBE.FIRST_COMMENT - 1]);
  } catch (e) { /* non-fatal — video is already up */ }

  // Add to the niche playlist (Food/Places/Countries), if one is configured.
  try {
    addToNichePlaylist_(data.id, contentId, accessToken);
  } catch (e) { /* non-fatal */ }

  return data.id;
}

function postFirstComment_(accessToken, videoId, commentText) {
  if (!commentText) return;
  UrlFetchApp.fetch("https://www.googleapis.com/youtube/v3/commentThreads?part=snippet", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + accessToken },
    payload: JSON.stringify({
      snippet: { videoId: videoId, topLevelComment: { snippet: { textOriginal: commentText } } }
    }),
    muteHttpExceptions: true
  });
}

// Refresh-token OAuth flow — see README "One-time YouTube setup".
function getYoutubeAccessToken_() {
  const props = PropertiesService.getScriptProperties();
  const res = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    payload: {
      client_id: props.getProperty("YT_CLIENT_ID"),
      client_secret: props.getProperty("YT_CLIENT_SECRET"),
      refresh_token: props.getProperty("YT_REFRESH_TOKEN"),
      grant_type: "refresh_token"
    },
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());
  if (!data.access_token) throw new Error("YouTube token refresh failed: " + res.getContentText());
  return data.access_token;
}
