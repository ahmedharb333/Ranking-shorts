/* ============================================================================
   Visuals.js — RankingShorts Content OS
   Stage 2B: resolves each Visual Library row to an actual clip —
   Pexels download for standard items, Kling submission for the #1 hero shot.
   ============================================================================ */

function stage2b_resolveVisuals() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.VISUAL);
  const data = sh.getDataRange().getValues();

  // AI-image generation is slow (~10-30s each). Cap this stage so it can't blow
  // the tick's 6-min budget — remaining items resolve on the next tick.
  const startedAt = Date.now();
  const BUDGET_MS = 90 * 1000;

  for (let i = 1; i < data.length; i++) {
    if (Date.now() - startedAt > BUDGET_MS) break;
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
      } else if (source === "aiimage") {
        const url = fetchAiImage_(query, id);
        sh.getRange(i + 1, COL_VISUAL.CLIP_URL).setValue(url);
        sh.getRange(i + 1, COL_VISUAL.STATUS).setValue("Ready");
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

// ── AI image (free) ──────────────────────────────────────────────────────────
// Pollinations.ai: free, no key. Generates a vertical image for the item and
// saves it to Drive; the composition applies a slow Ken Burns zoom so it reads
// as motion b-roll. Great for luxury/novelty subjects Pexels can't cover.
function fetchAiImage_(query, contentId) {
  // Subject first (so the model renders the literal item), then a niche-tuned
  // style so food looks like food photography and places look like travel shots.
  const niche = nicheFolderName_(contentId); // Food / Places / Countries / Other
  const styleByNiche = {
    Food: "professional food photography, appetizing, close-up, shallow depth of field",
    Places: "travel destination photography, iconic recognizable landmark, golden hour light",
    Countries: "iconic recognizable scenery of the place, cinematic wide establishing shot",
  };
  const style = styleByNiche[niche] || "photorealistic, professional photography, natural lighting";
  const prompt = "the subject of the photo is " + query + ". " + style +
    ", sharp focus, high detail, vertical 9:16";
  // Deterministic per-item seed: keeps a subject stable across retries but makes
  // near-identical prompts render visibly different images (variety guard).
  const seed = Math.abs(hashStr_(String(contentId) + "|" + query)) % 100000;
  const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) +
    "?width=1080&height=1920&nologo=true&model=flux&seed=" + seed;

  // One validated Pollinations attempt (it occasionally returns a bad/empty body
  // that would break the render); on any problem, fall straight to Pexels to
  // keep the stage fast.
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      const blob = res.getBlob();
      if ((blob.getContentType() || "").indexOf("image/") === 0 && blob.getBytes().length > 1500) {
        blob.setName("aiimg_" + Utilities.getUuid().slice(0, 8) + ".jpg");
        const file = getContentFolder_(contentId).createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        return "https://drive.google.com/uc?id=" + file.getId();
      }
    }
  } catch (e) { /* fall through to Pexels */ }

  // Fallback: a real Pexels stock PHOTO (free, instant, stays an image).
  try { return fetchPexelsPhoto_(query, contentId); } catch (e) { /* fall through */ }

  // Last resort: no visual — the render shows a black scene with the overlays.
  return "";
}

// Pexels PHOTO search (not video), saved to Drive — used as the AI-image fallback.
function fetchPexelsPhoto_(query, contentId) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("PEXELS_API_KEY");
  const res = UrlFetchApp.fetch(
    "https://api.pexels.com/v1/search?orientation=portrait&per_page=1&query=" + encodeURIComponent(query),
    { headers: { Authorization: apiKey }, muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());
  const photo = data.photos && data.photos[0];
  if (!photo || !photo.src) throw new Error("No Pexels photo for: " + query);
  const src = photo.src.large2x || photo.src.large || photo.src.original;
  return saveUrlToDrive_(src, "pexels_photo_" + photo.id + ".jpg", contentId);
}

// ── Kling auth ─────────────────────────────────────────────────────────────
// New-format Kling API key (from kling.ai/dev/api-key): passed directly as a
// Bearer token — no JWT signing (that was the legacy Access/Secret Key flow).
function klingAuthToken_() {
  const key = PropertiesService.getScriptProperties().getProperty("KLING_API_KEY");
  if (!key) throw new Error("KLING_API_KEY missing from Script Properties");
  return key;
}

function submitKlingJob_(prompt) {
  const res = UrlFetchApp.fetch(KLING_API_URL, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + klingAuthToken_() },
    // Send both model + model_name — Kling's docs disagree on the field name and
    // REST APIs ignore unknown fields. Validate against a real response on run 1.
    payload: JSON.stringify((function () { const m = getKlingModel_(); return { model: m, model_name: m, prompt: prompt, aspect_ratio: "9:16", duration: 5 }; })()),
    muteHttpExceptions: true
  });
  const body = res.getContentText();
  const data = JSON.parse(body);
  // Official API nests the task under "data"; some wrappers keep it flat.
  const taskId = (data.data && data.data.task_id) || data.task_id;
  if (!taskId) throw new Error("Kling submission failed: " + body.slice(0, 300));
  return taskId;
}

function pollPendingKlingJobs_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.VISUAL);
  const data = sh.getDataRange().getValues();
  const token = klingAuthToken_();

  for (let i = 1; i < data.length; i++) {
    if (data[i][COL_VISUAL.STATUS - 1] !== "Rendering") continue;
    const taskId = data[i][COL_VISUAL.KLING_TASK_ID - 1];

    try {
      const res = UrlFetchApp.fetch(KLING_API_URL + "/" + taskId, {
        headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true
      });
      const j = JSON.parse(res.getContentText());
      const d = j.data || j; // official API nests under "data"
      const status = d.task_status || d.status || "";
      // Video URL lives at task_result.videos[0].url (official) or video_url (flat).
      const videoUrl = (d.task_result && d.task_result.videos && d.task_result.videos[0] && d.task_result.videos[0].url)
        || d.video_url || "";

      if ((status === "succeed" || status === "completed") && videoUrl) {
        const driveUrl = saveUrlToDrive_(videoUrl, "kling_" + taskId + ".mp4", data[i][COL_VISUAL.ID - 1]);
        sh.getRange(i + 1, COL_VISUAL.CLIP_URL).setValue(driveUrl);
        sh.getRange(i + 1, COL_VISUAL.STATUS).setValue("Ready");
      } else if (status === "failed") {
        sh.getRange(i + 1, COL_VISUAL.STATUS).setValue("Failed");
        logError("Stage 2B — Kling Poll", taskId, "Render Failed", d.task_status_msg || "Kling reported failed");
      }
      // else still rendering — checked again next tick
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

// The per-video folder, nested by niche:  <production>/<Niche>/<contentId>/
function getContentFolder_(contentId) {
  if (!contentId) throw new Error("getContentFolder_ requires a contentId");
  const nicheFolder = getOrCreateChildFolder_(getProductionFolder_(), nicheFolderName_(contentId));
  return getOrCreateChildFolder_(nicheFolder, String(contentId));
}

function getOrCreateChildFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// Small deterministic string hash (for stable per-item AI image seeds).
function hashStr_(s) {
  let h = 0;
  s = String(s);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// Niche folder name from the contentId prefix (food-.. / places-.. / countries-..).
function nicheFolderName_(contentId) {
  const prefix = String(contentId).split("-")[0].toLowerCase();
  for (var i = 0; i < NICHES.length; i++) {
    if (NICHES[i].toLowerCase() === prefix) return NICHES[i];
  }
  return "Other";
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
