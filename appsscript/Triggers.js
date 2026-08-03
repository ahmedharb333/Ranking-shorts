/* ============================================================================
   Triggers.js — RankingShorts Content OS
   THE AUTOMATION LAYER — this is what makes it different from GovernX's
   manual "click Stage 3, review, click Stage 4" workflow.

   Run installAutomation() ONCE from the Apps Script editor. It installs a
   time-based trigger that calls runPipelineTick() every 15 minutes. Each
   tick advances whatever's ready to move forward, and stops itself well
   before the 6-min Apps Script execution cap.

   To reach ~4 videos/day: Stage 0 keeps a buffer of queued topics, and each
   tick processes one script through as many stages as time allows, so over
   ~96 ticks/day the pipeline naturally produces 3-5 finished uploads.
   Nothing here needs a human unless something lands in the Error Log.
   ============================================================================ */

function installAutomation() {
  // Clear any existing triggers first so this is idempotent.
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger("runPipelineTick").timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger("stage0_refillTopicQueue").timeBased().everyHours(6).create();
  ScriptApp.newTrigger("dailyErrorDigest").timeBased().atHour(9).everyDays(1).create();

  SpreadsheetApp.getUi().alert("Automation installed. The pipeline will now run itself every 15 minutes.");
}

function runPipelineTick() {
  const startedAt = Date.now();

  function timeLeft() { return MAX_PIPELINE_RUNTIME_PER_TICK_MS - (Date.now() - startedAt); }

  // 1. Advance any script that hasn't been through Stage 1 yet.
  if (timeLeft() > 20000) stage1_generateScript();

  // 1.5 Fact-check the next unverified script (web_search) before anything is
  //     built from it. Needs headroom — web_search calls are slow.
  if (timeLeft() > 60000) stage1b_verifyReadyScripts();

  // 2. Build visual plans for scripts that have one but no visuals yet.
  forEachReadyScript_(SHEET.VISUAL, function (id) {
    if (timeLeft() > 15000) stage2_buildVisualPlan(id);
  });

  // 3. Resolve visuals (Pexels fetch + Kling poll).
  if (timeLeft() > 20000) stage2b_resolveVisuals();

  // 4. Generate voiceover for scripts whose visuals are fully "Ready".
  forEachVisualsReadyScript_(function (id) {
    if (timeLeft() > 20000) stage3_generateVoiceover(id);
  });

  // 5. Submit assembly jobs for scripts with complete audio.
  forEachAudioReadyScript_(function (id) {
    if (timeLeft() > 15000) {
      try { stage4_submitAssembly(id); } catch (err) { logError("Stage 4 — Submit", id, "Submit Error", err.message); }
    }
  });

  // 6. Poll in-flight renders — cheap, always run if time allows.
  if (timeLeft() > 10000) stage4b_pollAssemblyJobs();

  // 7. Generate YouTube metadata for scripts that don't have it yet.
  forEachReadyScript_(SHEET.YOUTUBE, function (id) {
    if (timeLeft() > 10000) stage4_5_generateYoutubeMetadata(id);
  });

  // 8. Upload anything fully rendered + has metadata.
  if (timeLeft() > 15000) stage5_uploadReadyVideos();

  // 9. Refresh view stats for published videos (feeds the Stage 0 winners loop).
  if (timeLeft() > 8000) stage6_updatePublishingStats();
}

// ── Helpers: find scripts that are ready for the NEXT stage but haven't
//    appeared in the next sheet yet ───────────────────────────────────────────

function forEachReadyScript_(targetSheet, fn) {
  const scriptIds = SpreadsheetApp.getActive().getSheetByName(SHEET.SCRIPT)
    .getDataRange().getValues().slice(1).map(function (r) { return r[COL_SCRIPT.ID - 1]; });
  const existingIds = SpreadsheetApp.getActive().getSheetByName(targetSheet)
    .getDataRange().getValues().slice(1).map(function (r) { return r[0]; });

  scriptIds.filter(function (id) { return existingIds.indexOf(id) === -1; }).forEach(fn);
}

function forEachVisualsReadyScript_(fn) {
  const visualSh = SpreadsheetApp.getActive().getSheetByName(SHEET.VISUAL).getDataRange().getValues().slice(1);
  const audioIds = SpreadsheetApp.getActive().getSheetByName(SHEET.AUDIO)
    .getDataRange().getValues().slice(1).map(function (r) { return r[0]; });

  const byScript = {};
  visualSh.forEach(function (r) {
    const id = r[COL_VISUAL.ID - 1];
    byScript[id] = byScript[id] || [];
    byScript[id].push(r[COL_VISUAL.STATUS - 1]);
  });

  Object.keys(byScript).forEach(function (id) {
    const allReady = byScript[id].every(function (s) { return s === "Ready"; });
    if (allReady && audioIds.indexOf(id) === -1) fn(id);
  });
}

function forEachAudioReadyScript_(fn) {
  const audioSh = SpreadsheetApp.getActive().getSheetByName(SHEET.AUDIO).getDataRange().getValues().slice(1);
  const assemblyIds = SpreadsheetApp.getActive().getSheetByName(SHEET.ASSEMBLY)
    .getDataRange().getValues().slice(1).map(function (r) { return r[0]; });

  const byScript = {};
  audioSh.forEach(function (r) {
    const id = r[COL_AUDIO.ID - 1];
    byScript[id] = byScript[id] || [];
    byScript[id].push(r[COL_AUDIO.STATUS - 1]);
  });

  Object.keys(byScript).forEach(function (id) {
    const allReady = byScript[id].every(function (s) { return s === "Ready"; });
    if (allReady && assemblyIds.indexOf(id) === -1) fn(id);
  });
}

// ── The ONLY thing that reaches you: a daily digest, not a per-video ping ────
function dailyErrorDigest() {
  // Give any parked "Verify Failed" scripts a fresh set of attempts each day —
  // new sources may exist online now, so the pipeline keeps healing itself.
  resetVerifyFailedToReady_();

  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.ERROR_LOG);
  const rows = sh.getDataRange().getValues().slice(1)
    .filter(function (r) { return r[COL_ERROR.RESOLVED - 1] !== "YES"; });

  if (rows.length === 0) return; // silence is the default — true zero-interference

  const email = PropertiesService.getScriptProperties().getProperty("ALERT_EMAIL");
  if (!email) return;

  const body = rows.map(function (r) {
    return r[COL_ERROR.STAGE - 1] + " | " + r[COL_ERROR.ID - 1] + " | " + r[COL_ERROR.DETAILS - 1];
  }).join("\n");

  MailApp.sendEmail(email, "RankingShorts: " + rows.length + " unresolved errors", body);
}
