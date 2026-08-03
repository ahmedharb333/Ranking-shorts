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
  // Wider avoid-list: every idea title ever queued + every published title.
  const ideaTitles = sh.getDataRange().getValues().slice(1)
    .map(function (r) { return r[COL_IDEA.WORKING_TITLE - 1]; }).filter(function (x) { return x; });
  const avoid = ideaTitles.concat(getPublishedTitles_());
  const killed = getKilledTopics_();

  // Hard-dedup set: normalized titles already used (also blocks intra-batch dupes).
  const seen = {};
  avoid.forEach(function (t) { seen[normalizeTitle_(t)] = true; });

  NICHES.forEach(function (niche) {
    const queuedCount = sh.getDataRange().getValues().slice(1)
      .filter(function (r) { return r[COL_IDEA.NICHE - 1] === niche && r[COL_IDEA.STATUS - 1] === "Queued"; }).length;
    if (queuedCount >= 3) return; // keep a buffer of 3 per niche, don't over-generate

    // Legal trend signals (YouTube Data API + Google Trends) as inspiration.
    const trends = getTrendSignals_(niche);
    const trendBlock = trends.length
      ? "For inspiration, here's what's currently trending / performing well on this topic (take inspiration for angles, but create DISTINCT new ideas — do NOT copy these):\n" + trends.join("\n") + "\n"
      : "";

    // Your own winners: double down on what already worked for this channel.
    const winners = getWinnerTopics_(niche);
    const winnerBlock = winners.length
      ? "YOUR best-performing videos so far — lean INTO these winning angles and make MORE like them (still distinct new topics, not repeats):\n" + winners.join("\n") + "\n"
      : "";

    const prompt = "Suggest 3 new specific video topics for the '" + niche + "' ranking pillar.\n" +
      winnerBlock + trendBlock +
      "Avoid these already-used titles — do NOT repeat OR reword them:\n" + avoid.join("\n") + "\n" +
      "Avoid these killed/underperforming topics too:\n" + killed.join("\n") + "\n" +
      "Return strict JSON: {\"topics\":[{\"title\":\"...\",\"angle\":\"countdown|comparison|myth-bust|perspective\"}]}";

    try {
      const raw = callClaude(prompt, "stage0_topic_pick");
      const parsed = parseClaudeJson(raw);

      // 1) exact/normalized dedup
      let candidates = (parsed.topics || []).filter(function (t) {
        const norm = normalizeTitle_(t.title);
        return norm && !seen[norm];
      });
      // 2) semantic dedup — catch reworded / same-idea repeats
      candidates = filterSemanticDuplicates_(candidates, avoid);

      // 3) queue the survivors
      const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd");
      let seq = nextSeqForNicheDate_(sh, niche, today);
      candidates.forEach(function (t) {
        const norm = normalizeTitle_(t.title);
        if (seen[norm]) return; // guard: two survivors could normalize the same
        seen[norm] = true;
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

// Semantic dedup: asks Claude which candidates are genuinely NEW vs. cover the
// same idea as an existing title (reworded/synonyms/reordered). Fail-open — a
// bad/empty response keeps all candidates, since exact dedup already ran.
function filterSemanticDuplicates_(candidates, existingTitles) {
  if (!candidates.length || !existingTitles.length) return candidates;
  try {
    const list = candidates.map(function (c, i) { return i + ". " + c.title; }).join("\n");
    const prompt = "Deduplicate video topic ideas by MEANING, not wording.\n\n" +
      "EXISTING topics (already made or queued):\n" + existingTitles.join("\n") + "\n\n" +
      "CANDIDATE new topics:\n" + list + "\n\n" +
      "A candidate is a DUPLICATE if it covers essentially the same ranking/subject as ANY existing " +
      "topic — even if reworded, reordered, or using synonyms. Keep only genuinely distinct ideas.\n" +
      "Return strict JSON with the indexes to KEEP: {\"keep\": [0, 2]}";
    const parsed = parseClaudeJson(callClaude(prompt, "stage0_dedup"));
    if (!parsed || !Array.isArray(parsed.keep)) return candidates; // malformed -> fail-open
    return parsed.keep.map(function (i) { return candidates[i]; }).filter(function (x) { return x; });
  } catch (e) {
    return candidates; // never block topic generation on the dedup check
  }
}

// Normalizes a title for duplicate comparison: lowercase, punctuation stripped.
function normalizeTitle_(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Maps content ID -> title (Script Bank title preferred, else Idea working title).
function idTitleMap_() {
  const map = {};
  const idea = SpreadsheetApp.getActive().getSheetByName(SHEET.IDEA);
  if (idea) idea.getDataRange().getValues().slice(1).forEach(function (r) {
    if (r[COL_IDEA.ID - 1]) map[r[COL_IDEA.ID - 1]] = r[COL_IDEA.WORKING_TITLE - 1];
  });
  const script = SpreadsheetApp.getActive().getSheetByName(SHEET.SCRIPT);
  if (script) script.getDataRange().getValues().slice(1).forEach(function (r) {
    if (r[COL_SCRIPT.ID - 1] && r[COL_SCRIPT.TITLE - 1]) map[r[COL_SCRIPT.ID - 1]] = r[COL_SCRIPT.TITLE - 1];
  });
  return map;
}

// Maps content ID -> niche (from the Idea Catalogue).
function idNicheMap_() {
  const map = {};
  const idea = SpreadsheetApp.getActive().getSheetByName(SHEET.IDEA);
  if (idea) idea.getDataRange().getValues().slice(1).forEach(function (r) {
    if (r[COL_IDEA.ID - 1]) map[r[COL_IDEA.ID - 1]] = r[COL_IDEA.NICHE - 1];
  });
  return map;
}

// Titles of everything already published (Publishing Tracker IDs -> titles).
function getPublishedTitles_() {
  const pub = SpreadsheetApp.getActive().getSheetByName(SHEET.PUBLISHING);
  if (!pub) return [];
  const ids = pub.getDataRange().getValues().slice(1)
    .map(function (r) { return r[COL_PUBLISHING.ID - 1]; }).filter(function (x) { return x; });
  if (!ids.length) return [];
  const titleById = idTitleMap_();
  return ids.map(function (id) { return titleById[id]; }).filter(function (x) { return x; });
}

// Safety net: strip numbers/units/symbols from a visual query so stock/AI
// search never keys off a stray "2,200,000 SHU" or "$63" (which mislead it).
function cleanVisualQuery_(q) {
  const cleaned = String(q || "")
    .replace(/\$?\d[\d,\.]*\s*(shu|cal|kcal|usd|dollars?|units?)?/gi, " ")
    .replace(/[#\/|]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || String(q || "").trim();
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
  const killedIds = sh.getDataRange().getValues().slice(1)
    .filter(function (r) { return r[COL_PUBLISHING.REPEAT_DECISION - 1] === "Kill"; })
    .map(function (r) { return r[COL_PUBLISHING.ID - 1]; });
  if (!killedIds.length) return [];
  // Resolve IDs -> real titles so Claude can actually avoid the topic (an
  // opaque ID like "food-20260803-001" is useless as an avoid instruction).
  const titleById = idTitleMap_();
  return killedIds.map(function (id) { return titleById[id] || null; }).filter(function (x) { return x; });
}

// ── STAGE 1 — Script Generation ───────────────────────────────────────────────
function stage1_generateScript() {
  const idea = nextQueuedIdea_();
  if (!idea) return false;
  return generateScriptForIdea_(idea);
}

// Generates the script for a SPECIFIC idea (used by the automatic queue and by
// the "Start selected idea" menu action, which can jump the queue).
function generateScriptForIdea_(idea) {
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
    const isTop = item.rank === 1;
    let source = "pexels";
    if (videoMode === "all" || (videoMode === "hero" && isTop)) source = "kling";
    else if (videoMode === "ai-image-all" || (videoMode === "ai-image" && isTop)) source = "aiimage";
    // Clean, stock/AI-friendly visual query (never numbers/captions, which
    // returned mountains for "Carolina Reaper Wings 2.2M SHU peak").
    const query = cleanVisualQuery_(item.search_query || item.name);
    visualSh.appendRow([scriptId, idx, query, source, "", "", "Queued", ""]);
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
