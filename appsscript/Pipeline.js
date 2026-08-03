/* ============================================================================
   Pipeline.js — RankingShorts Content OS

   Stage 0: Topic Pick        — choose next niche + angle, avoid repeats
   Stage 1: Script Generation — Claude writes the ranking script (strict JSON)
   Stage 2: Visual Plan       — per-item Pexels query + AI hero shot for #1
   Stage 3: Voiceover         — ElevenLabs per-line audio
   Stage 4: Assembly Submit   — POST job to local Remotion render server
   Stage 4.5: YouTube Metadata
   Stage 5: Upload            — polls render server, then pushes to YouTube

   Unlike GovernX, these are called by Triggers.js on a schedule, not a human
   clicking a menu. Each stage still logs to Error Log and SKIPS forward only
   on success — a stuck row simply gets retried on the next tick.
   ============================================================================ */

function logError(stage, id, type, details) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.ERROR_LOG);
  sh.appendRow([new Date(), stage, id, type, details, "NO"]);
}

function nextQueuedIdea_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.IDEA);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if ((data[i][COL_IDEA.STATUS - 1] || "").toString() === "Queued") {
      return { row: i + 1, id: data[i][COL_IDEA.ID - 1], niche: data[i][COL_IDEA.NICHE - 1],
               title: data[i][COL_IDEA.WORKING_TITLE - 1], angle: data[i][COL_IDEA.ANGLE - 1] };
    }
  }
  return null;
}

// ── STAGE 0 — Topic Pick ──────────────────────────────────────────────────────
// Keeps the Idea Catalogue stocked. Rotates niches, checks Publishing Tracker
// so a sub-topic marked "Kill" doesn't get repeated.
function stage0_refillTopicQueue() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.IDEA);
  const existing = sh.getDataRange().getValues().slice(1).map(function (r) { return r[COL_IDEA.WORKING_TITLE - 1]; });
  const killed = getKilledTopics_();

  NICHES.forEach(function (niche) {
    const queuedCount = sh.getDataRange().getValues().slice(1)
      .filter(function (r) { return r[COL_IDEA.NICHE - 1] === niche && r[COL_IDEA.STATUS - 1] === "Queued"; }).length;
    if (queuedCount >= 3) return; // keep a buffer of 3 per niche, don't over-generate

    const prompt = "Suggest 3 new specific video topics for the '" + niche + "' ranking pillar.\n" +
      "Avoid these already-used titles:\n" + existing.join("\n") + "\n" +
      "Avoid these killed/underperforming sub-topics:\n" + killed.join("\n") + "\n" +
      "Return strict JSON: {\"topics\":[{\"title\":\"...\",\"angle\":\"countdown|comparison|myth-bust|perspective\"}]}";

    try {
      const raw = callClaude(prompt, "stage0_topic_pick");
      const parsed = parseClaudeJson(raw);
      const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd");
      let seq = nextSeqForNicheDate_(sh, niche, today);
      parsed.topics.forEach(function (t) {
        // Human-readable ID: niche-YYYYMMDD-NNN, counted per niche per day.
        const id = niche.toLowerCase() + "-" + today + "-" + pad3_(seq);
        seq++;
        sh.appendRow([id, niche, t.title, t.angle, "Normal", "Queued", "", ""]);
      });
    } catch (err) {
      logError("Stage 0 — Topic Pick", niche, "API Error", err.message);
    }
  });
}

// Next sequence number for a niche on a given day (scans existing IDs).
function nextSeqForNicheDate_(sh, niche, yyyymmdd) {
  const prefix = niche.toLowerCase() + "-" + yyyymmdd + "-";
  const ids = sh.getDataRange().getValues().slice(1)
    .map(function (r) { return String(r[COL_IDEA.ID - 1] || ""); });
  let max = 0;
  ids.forEach(function (id) {
    if (id.indexOf(prefix) === 0) {
      const n = parseInt(id.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return max + 1;
}

function pad3_(n) {
  n = String(n);
  return n.length >= 3 ? n : ("000" + n).slice(-3);
}

function getKilledTopics_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.PUBLISHING);
  if (!sh) return [];
  return sh.getDataRange().getValues().slice(1)
    .filter(function (r) { return r[COL_PUBLISHING.REPEAT_DECISION - 1] === "Kill"; })
    .map(function (r) { return r[COL_PUBLISHING.ID - 1]; });
}

// ── STAGE 1 — Script Generation ───────────────────────────────────────────────
function stage1_generateScript() {
  const idea = nextQueuedIdea_();
  if (!idea) return false;

  const prompt = "Niche: " + idea.niche + "\nWorking title: " + idea.title +
    "\nAngle: " + idea.angle + "\n\nWrite the full ranking video per the system format rules.";

  try {
    const raw = callClaude(prompt, "stage1_script");
    const parsed = parseClaudeJson(raw);

    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.SCRIPT);
    sh.appendRow([
      idea.id, idea.niche, parsed.title, parsed.hook,
      JSON.stringify(parsed.rank_items), parsed.voiceover_script, parsed.cta,
      parsed.duration_target_sec, JSON.stringify(parsed.quality_check), "Ready", ""
    ]);

    updateIdeaStatus_(idea.row, "In Progress", "S1✅");
    return true;
  } catch (err) {
    logError("Stage 1 — Script", idea.id, "API Error", err.message);
    return false;
  }
}

function updateIdeaStatus_(row, status, pipelineTag) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.IDEA);
  sh.getRange(row, COL_IDEA.STATUS).setValue(status);
  const cell = sh.getRange(row, COL_IDEA.PIPELINE_STATUS);
  cell.setValue(((cell.getValue() || "") + " " + pipelineTag).trim());
}

// ── STAGE 2 — Visual Plan ─────────────────────────────────────────────────────
// Builds one Pexels search query per ranked item, and flags the #1 item for
// an AI hero shot (Kling/Veo) per the mix-mode default.
function stage2_buildVisualPlan(scriptId) {
  const scriptRow = findRowById_(SHEET.SCRIPT, scriptId, COL_SCRIPT.ID);
  if (!scriptRow) return false;
  // Only proceed once facts are verified (Stage 1.5). Unverified/failed scripts
  // wait here and are retried next tick — nothing gets made from unchecked facts.
  if (scriptRow[COL_SCRIPT.STATUS - 1] !== "Verified") return false;

  const rankItems = JSON.parse(scriptRow[COL_VISUAL_ITEMS_JSON_INDEX(scriptRow)]);
  const visualSh = SpreadsheetApp.getActive().getSheetByName(SHEET.VISUAL);

  const videoMode = getVideoMode_();
  rankItems.forEach(function (item, idx) {
    const useKling = videoMode === "all" || (videoMode === "hero" && item.rank === 1);
    visualSh.appendRow([
      scriptId, idx, item.name + " " + (item.on_screen_text || ""),
      useKling ? "kling" : "pexels", "", "", "Queued", ""
    ]);
  });
  return true;
}

function COL_VISUAL_ITEMS_JSON_INDEX(row) { return COL_SCRIPT.RANK_ITEMS_JSON - 1; }

function findRowById_(sheetName, id, idCol) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol - 1] === id) return data[i];
  }
  return null;
}
