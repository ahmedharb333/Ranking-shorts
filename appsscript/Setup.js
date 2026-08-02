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
   Then run installAutomation() once. That's the entire manual setup.
   ============================================================================ */

function onOpen() {
  SpreadsheetApp.getUi().createMenu("RankingShorts")
    .addItem("1. Setup sheets", "setupSheets")
    .addItem("2. Install automation (run once)", "installAutomation")
    .addSeparator()
    .addItem("Run one tick now (manual test)", "runPipelineTick")
    .addItem("Refill topic queue now", "stage0_refillTopicQueue")
    .addToUi();
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
