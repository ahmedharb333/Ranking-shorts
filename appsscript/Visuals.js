/* ============================================================================
   Visuals.js — RankingShorts Content OS
   Stage 2B: resolves each Visual Library row to an actual clip —
   Pexels download for standard items, Kling submission for the #1 hero shot.
   ============================================================================ */

function stage2b_resolveVisuals() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.VISUAL);
  const data = sh.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const status = data[i][COL_VISUAL.STATUS - 1];
    if (status !== "Queued") continue;

    const source = data[i][COL_VISUAL.SOURCE - 1];
    const query = data[i][COL_VISUAL.SEARCH_QUERY - 1];
    const id = data[i][COL_VISUAL.ID - 1];

    try {
      if (source === "pexels") {
        const url = fetchPexelsClip_(query, id);
        sh.getRange(i + 1, COL_VISUAL.CLIP_URL).setValue(url);
        sh.getRange(i + 1, COL_VISUAL.STATUS).setValue("Ready");
      } else if (source === "kling") {
        const taskId = submitKlingJob_(query);
        sh.getRange(i + 1, COL_VISUAL.KLING_TASK_ID).setValue(taskId);
        sh.getRange(i + 1, COL_VISUAL.STATUS).setValue("Rendering");
      }
    } catch (err) {
      logError("Stage 2B — Visuals", id, "Visual Fetch Error", err.message);
    }
  }

  pollPendingKlingJobs_();
}

function fetchPexelsClip_(query, contentId) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("PEXELS_API_KEY");
  const res = UrlFetchApp.fetch(
    PEXELS_API_URL + "?query=" + encodeURIComponent(query) + "&orientation=portrait&per_page=1",
    { headers: { Authorization: apiKey }, muteHttpExceptions: true }
  );
  const data = JSON.parse(res.getContentText());
  const video = data.videos && data.videos[0];
  if (!video) throw new Error("No Pexels result for query: " + query);
  // Prefer HD portrait file
  const file = video.video_files.find(function (f) { return f.quality === "hd" && f.width < f.height; })
    || video.video_files[0];
  return saveUrlToDrive_(file.link, "pexels_" + video.id + ".mp4", contentId);
}

// ── Kling auth ─────────────────────────────────────────────────────────────
// Kling does NOT use a simple API key. It issues an Access Key + Secret Key,
// and every request needs a short-lived JWT (HS256) signed with the secret:
//   header: {alg: "HS256", typ: "JWT"}
//   payload: {iss: accessKey, exp: now+1800s, nbf: now-5s}
// Apps Script has no JWT library, so we build it manually with
// Utilities.computeHmacSha256Signature + base64url encoding.
function buildKlingJwt_() {
  const accessKey = PropertiesService.getScriptProperties().getProperty("KLING_ACCESS_KEY");
  const secretKey = PropertiesService.getScriptProperties().getProperty("KLING_SECRET_KEY");
  if (!accessKey || !secretKey) throw new Error("KLING_ACCESS_KEY / KLING_SECRET_KEY missing from Script Properties");

  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { iss: accessKey, exp: nowSec + 1800, nbf: nowSec - 5 };

  const base64url = function (obj) {
    return Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, "");
  };

  const unsigned = base64url(header) + "." + base64url(payload);
  const sigBytes = Utilities.computeHmacSha256Signature(unsigned, secretKey);
  const signature = Utilities.base64EncodeWebSafe(sigBytes).replace(/=+$/, "");

  return unsigned + "." + signature;
}

function submitKlingJob_(prompt) {
  const jwt = buildKlingJwt_();
  const res = UrlFetchApp.fetch(KLING_API_URL, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + jwt },
    payload: JSON.stringify({ model: KLING_MODEL, prompt: prompt, aspect_ratio: "9:16" }),
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());
  if (!data.task_id) throw new Error("Kling submission failed: " + res.getContentText().slice(0, 300));
  return data.task_id;
}

function pollPendingKlingJobs_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.VISUAL);
  const data = sh.getDataRange().getValues();
  const jwt = buildKlingJwt_(); // one fresh token covers all polls this tick (30 min validity)

  for (let i = 1; i < data.length; i++) {
    if (data[i][COL_VISUAL.STATUS - 1] !== "Rendering") continue;
    const taskId = data[i][COL_VISUAL.KLING_TASK_ID - 1];

    try {
      const res = UrlFetchApp.fetch(KLING_API_URL + "/" + taskId, {
        headers: { Authorization: "Bearer " + jwt }, muteHttpExceptions: true
      });
      const data2 = JSON.parse(res.getContentText());
      if (data2.status === "succeed" && data2.video_url) {
        const driveUrl = saveUrlToDrive_(data2.video_url, "kling_" + taskId + ".mp4", data[i][COL_VISUAL.ID - 1]);
        sh.getRange(i + 1, COL_VISUAL.CLIP_URL).setValue(driveUrl);
        sh.getRange(i + 1, COL_VISUAL.STATUS).setValue("Ready");
      }
      // else: still rendering, leave as-is, checked again next tick
    } catch (err) {
      logError("Stage 2B — Kling Poll", taskId, "Poll Error", err.message);
    }
  }
}

// Saves a remote file into the per-video content folder:
//   <production folder (DRIVE_FOLDER_ID)>/<contentId>/<filename>
function saveUrlToDrive_(url, filename, contentId) {
  const folder = getContentFolder_(contentId);
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const blob = res.getBlob().setName(filename);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return "https://drive.google.com/uc?id=" + file.getId();
}

// The production root folder, by ID (same folder the render server uploads to,
// set as Script Property DRIVE_FOLDER_ID). Both sides must agree so all of a
// video's assets and its final render live under one per-video folder.
function getProductionFolder_() {
  const id = PropertiesService.getScriptProperties().getProperty("DRIVE_FOLDER_ID");
  if (!id) throw new Error("DRIVE_FOLDER_ID not set in Script Properties — set it to your production folder's ID (same value as the render server's .env).");
  return DriveApp.getFolderById(id);
}

// The per-video folder, named by contentId, created under the production folder.
function getContentFolder_(contentId) {
  if (!contentId) throw new Error("getContentFolder_ requires a contentId");
  const parent = getProductionFolder_();
  const it = parent.getFoldersByName(String(contentId));
  return it.hasNext() ? it.next() : parent.createFolder(String(contentId));
}

// Handles both "https://drive.google.com/uc?id=XXX" (our own saveUrlToDrive_)
// and "https://drive.google.com/file/d/XXX/view" (webViewLink from the render
// server's direct Drive upload).
function extractDriveFileId_(url) {
  const ucMatch = url.match(/[?&]id=([^&]+)/);
  if (ucMatch) return ucMatch[1];
  const viewMatch = url.match(/\/d\/([^/]+)/);
  if (viewMatch) return viewMatch[1];
  throw new Error("Could not extract Drive file ID from: " + url);
}
