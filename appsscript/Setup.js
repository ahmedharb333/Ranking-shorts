/* ============================================================================
   Setup.js — RankingShorts Content OS
   Run setupSheets() once from the Apps Script editor to create every tab
   with headers. Then set Script Properties (File > Project properties >
   Script properties) for: ANTHROPIC_API_KEY, PEXELS_API_KEY, KLING_API_KEY,
   ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, REMOTION_SERVER_URL,
   YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN, ALERT_EMAIL, DRIVE_FOLDER_ID.
   Optional: USDA_API_KEY (free api.data.gov key) enables USDA food-nutrition
   grounding in the fact-verification stage; without it, food facts fall back to
   web search. Countries grounding (World Bank) needs no key.
   Optional: YOUTUBE_API_KEY (YouTube Data API v3 key, same Cloud project as the
   upload OAuth) enables the YouTube trend signal in the topic picker; without
   it, only Google Trends (best-effort) feeds trends.
   Then run installAutomation() once. That's the entire manual setup.
   ============================================================================ */

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("RankingShorts")
    .addSubMenu(ui.createMenu("Setup & automation")
      .addItem("1. Setup sheets", "setupSheets")
      .addItem("2. Install automation (run once)", "installAutomation")
      .addSeparator()
      .addItem("⏸ Pause automation", "pauseAutomation")
      .addItem("▶ Resume automation", "installAutomation"))
    .addSeparator()
    .addItem("▶ Start selected idea (generate script)", "menu_generateForActiveRow_")
    .addItem("▶ Run full tick now", "runPipelineTick")
    .addSubMenu(ui.createMenu("Run one stage")
      .addItem("0 · Refill topic queue", "stage0_refillTopicQueue")
      .addItem("1 · Generate next script", "menu_stage1_")
      .addItem("1.5 · Verify next script (web search)", "stage1b_verifyReadyScripts")
      .addItem("2 · Build visual plans", "menu_stage2Plans_")
      .addItem("2B · Resolve visuals (Pexels/Kling)", "stage2b_resolveVisuals")
      .addItem("3 · Generate voiceover", "menu_stage3_")
      .addItem("4 · Submit assembly", "menu_stage4Submit_")
      .addItem("4B · Poll renders", "stage4b_pollAssemblyJobs")
      .addItem("4.5 · YouTube metadata", "menu_stage45_")
      .addItem("5 · Upload ready videos", "stage5_uploadReadyVideos"))
    .addSubMenu(ui.createMenu("Settings")
      .addItem("Video mode → None (all Pexels)", "menu_setVideoNone_")
      .addItem("Video mode → Hero (Kling #1)", "menu_setVideoHero_")
      .addItem("Video mode → All (Kling every item)", "menu_setVideoAll_")
      .addItem("Video mode → AI image #1 (free)", "menu_setVideoAiImage_")
      .addItem("Video mode → AI image all (free)", "menu_setVideoAiImageAll_")
      .addSeparator()
      .addItem("Kling model → v1 (cheap ~$0.18)", "menu_setKlingV1_")
      .addItem("Kling model → v2 (better, pricier)", "menu_setKlingV2_")
      .addSeparator()
      .addItem("Show current settings", "showSettings"))
    .addSeparator()
    .addItem("📊 Show pipeline status", "showPipelineStatus")
    .addToUi();
}

// ── Settings toggles (write Script Properties; read live via getters) ─────────
function menu_setVideoNone_() { setProp_("VIDEO_MODE", "none", "Video mode → none (all Pexels stock)"); }
function menu_setVideoHero_() { setProp_("VIDEO_MODE", "hero", "Video mode → hero (Kling AI for #1 only)"); }
function menu_setVideoAll_()  { setProp_("VIDEO_MODE", "all", "Video mode → all (Kling AI for EVERY item — higher cost/slower)"); }
function menu_setVideoAiImage_()    { setProp_("VIDEO_MODE", "ai-image", "Video mode → ai-image (FREE AI image for #1, Pexels for the rest)"); }
function menu_setVideoAiImageAll_() { setProp_("VIDEO_MODE", "ai-image-all", "Video mode → ai-image-all (FREE AI image for EVERY item)"); }
function menu_setKlingV1_()   { setProp_("KLING_MODEL", "kling-v1", "Kling model → kling-v1 (~$0.18/clip)"); }
function menu_setKlingV2_()   { setProp_("KLING_MODEL", "kling-v2", "Kling model → kling-v2 (better quality, higher cost)"); }

function setProp_(key, value, msg) {
  PropertiesService.getScriptProperties().setProperty(key, value);
  SpreadsheetApp.getUi().alert(msg + "\n\nApplies to the next video generated.");
}

function showSettings() {
  const p = PropertiesService.getScriptProperties();
  const msg =
    "Video mode:  " + getVideoMode_() + (p.getProperty("VIDEO_MODE") ? "" : "  (default)") + "\n" +
    "Kling model: " + getKlingModel_() + (p.getProperty("KLING_MODEL") ? "" : "  (default)");
  SpreadsheetApp.getUi().alert("Current settings", msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

// Starts the pipeline for the idea row you've selected in the Idea Catalogue
// (jumps the queue). Generates its script now; the rest flows through on the
// next ticks (or via "Run one stage").
function menu_generateForActiveRow_() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActive().getActiveSheet();
  if (sh.getName() !== SHEET.IDEA) {
    ui.alert("Open the '" + SHEET.IDEA + "' tab and click the idea row you want, then run this.");
    return;
  }
  const row = sh.getActiveRange().getRow();
  if (row < 2) { ui.alert("Pick an idea row (not the header)."); return; }

  const vals = sh.getRange(row, 1, 1, COL_IDEA.NOTE).getValues()[0];
  const idea = {
    row: row,
    id: vals[COL_IDEA.ID - 1],
    niche: vals[COL_IDEA.NICHE - 1],
    title: vals[COL_IDEA.WORKING_TITLE - 1],
    angle: vals[COL_IDEA.ANGLE - 1]
  };
  if (!idea.id || !idea.title) { ui.alert("That row has no ID or Working Title."); return; }

  if (findRowById_(SHEET.SCRIPT, idea.id, COL_SCRIPT.ID)) {
    const resp = ui.alert("Already started",
      "A script already exists for '" + idea.title + "'. Generate another anyway?", ui.ButtonSet.YES_NO);
    if (resp !== ui.Button.YES) return;
  }

  const ok = generateScriptForIdea_(idea);
  ui.alert(ok
    ? "✅ Script generated for '" + idea.title + "'.\n\nIt will now flow through verify → visuals → voiceover → render on the next ticks (or push it with 'Run one stage')."
    : "⚠️ Script generation failed for '" + idea.title + "' — check the Error Log tab.");
}

// ── Manual controls ──────────────────────────────────────────────────────────
// No-arg wrappers so single stages can be run from the menu. The per-id stages
// reuse the same "find what's ready" helpers the automatic tick uses.
function menu_stage1_()      { stage1_generateScript(); }
function menu_stage2Plans_() { forEachReadyScript_(SHEET.VISUAL, stage2_buildVisualPlan); }
function menu_stage3_()      { forEachVisualsReadyScript_(stage3_generateVoiceover); }
function menu_stage45_()     { forEachReadyScript_(SHEET.YOUTUBE, stage4_5_generateYoutubeMetadata); }
function menu_stage4Submit_() {
  forEachAudioReadyScript_(function (id) {
    try { stage4_submitAssembly(id); } catch (err) { logError("Stage 4 — Submit", id, "Submit Error", err.message); }
  });
}

function pauseAutomation() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  SpreadsheetApp.getUi().alert("Automation paused — all triggers removed. Use 'Resume automation' to restart.");
}

function showPipelineStatus() {
  const ss = SpreadsheetApp.getActive();
  function count(name) { const sh = ss.getSheetByName(name); return sh ? Math.max(0, sh.getLastRow() - 1) : 0; }
  const errSh = ss.getSheetByName(SHEET.ERROR_LOG);
  const unresolved = errSh
    ? errSh.getDataRange().getValues().slice(1).filter(function (r) { return r[COL_ERROR.RESOLVED - 1] !== "YES"; }).length
    : 0;
  const triggers = ScriptApp.getProjectTriggers().length;

  const msg =
    "Automation: " + (triggers ? triggers + " trigger(s) — RUNNING" : "PAUSED") + "\n" +
    "Video mode: " + getVideoMode_() + "  |  Kling model: " + getKlingModel_() + "\n\n" +
    "Idea queue:   " + count(SHEET.IDEA) + "\n" +
    "Scripts:      " + count(SHEET.SCRIPT) + "\n" +
    "Visuals:      " + count(SHEET.VISUAL) + "\n" +
    "Audio:        " + count(SHEET.AUDIO) + "\n" +
    "Assemblies:   " + count(SHEET.ASSEMBLY) + "\n" +
    "Metadata:     " + count(SHEET.YOUTUBE) + "\n" +
    "Published:    " + count(SHEET.PUBLISHING) + "\n\n" +
    "Unresolved errors: " + unresolved;
  SpreadsheetApp.getUi().alert("RankingShorts — pipeline status", msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

function setupSheets() {
  const ss = SpreadsheetApp.getActive();
  const specs = [
    [SHEET.IDEA, ["ID", "Niche", "Working Title", "Angle", "Priority", "Status", "Pipeline Status", "Note"]],
    [SHEET.SCRIPT, ["ID", "Niche", "Title", "Hook", "Rank Items JSON", "Voiceover Script", "CTA", "Duration Target", "Quality Check", "Status", "Note"]],
    [SHEET.VISUAL, ["ID", "Rank Item Idx", "Search Query", "Source", "Clip URL", "Kling Task ID", "Status", "Note"]],
    [SHEET.AUDIO, ["ID", "Rank Item Idx", "Audio URL", "Duration Sec", "Status"]],
    [SHEET.ASSEMBLY, ["ID", "Job ID", "Submitted At", "Status", "MP4 URL", "Note"]],
    [SHEET.YOUTUBE, ["ID", "Title A", "Title B", "Description", "Tags", "Hashtags", "First Comment", "Thumbnail Brief", "Status"]],
    [SHEET.PUBLISHING, ["ID", "Publish Date", "YouTube Video ID", "Views 24h", "Views 7d", "Retention", "Repeat Decision", "Note"]],
    [SHEET.ERROR_LOG, ["Timestamp", "Stage", "ID", "Error Type", "Details", "Resolved"]]
  ];

  specs.forEach(function (spec) {
    const name = spec[0], headers = spec[1];
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sh.setFrozenRows(1);
  });

  SpreadsheetApp.getUi().alert("Sheets created. Now set Script Properties, then run 'Install automation'.");
}
