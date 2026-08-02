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
function stage5_uploadReadyVideos() {
  const assemblySh = SpreadsheetApp.getActive().getSheetByName(SHEET.ASSEMBLY);
  const rows = assemblySh.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][COL_ASSEMBLY.STATUS - 1] !== "done") continue;
    const scriptId = rows[i][COL_ASSEMBLY.ID - 1];
    const mp4Url = rows[i][COL_ASSEMBLY.MP4_URL - 1];

    const alreadyPublished = findRowById_(SHEET.PUBLISHING, scriptId, COL_PUBLISHING.ID);
    if (alreadyPublished) continue;

    const meta = findRowById_(SHEET.YOUTUBE, scriptId, COL_YOUTUBE.ID);
    if (!meta) continue; // Stage 4.5 hasn't run yet for this one

    try {
      const videoId = uploadToYoutube_(mp4Url, meta);
      const pubSh = SpreadsheetApp.getActive().getSheetByName(SHEET.PUBLISHING);
      pubSh.appendRow([scriptId, new Date(), videoId, "", "", "", "", ""]);
    } catch (err) {
      logError("Stage 5 — Upload", scriptId, "Upload Error", err.message);
    }
  }
}

function uploadToYoutube_(driveMp4Url, meta) {
  const accessToken = getYoutubeAccessToken_();
  const fileId = extractDriveFileId_(driveMp4Url);
  const fileBlob = DriveApp.getFileById(fileId).getBlob();

  const metadata = {
    snippet: {
      title: meta[COL_YOUTUBE.TITLE_A - 1],
      description: meta[COL_YOUTUBE.DESCRIPTION - 1] + "\n\n" + meta[COL_YOUTUBE.HASHTAGS - 1],
      tags: (meta[COL_YOUTUBE.TAGS - 1] || "").split(",").map(function (t) { return t.trim(); })
    },
    status: { privacyStatus: "public", selfDeclaredMadeForKids: false }
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
