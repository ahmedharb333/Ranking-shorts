/* ============================================================================
   Verification.js — RankingShorts Content OS
   Stage 1.5: FACT VERIFICATION (route B).

   After Stage 1 writes a script, this stage fact-checks every ranked item with
   Claude's live web_search tool BEFORE any voiceover/visuals are made:
     - accurate claims are kept (numbers corrected to a real source)
     - wrong / unsourceable claims are REPLACED with a different, verifiable
       fact about the same item
     - every item ends up with a real source URL (surfaced later in the
       YouTube description at Stage 4.5)

   Gating: Stage 2 (visual plan) only proceeds once a script's Status is
   "Verified". A script that can't be verified is marked "Verify Failed" and
   surfaces in the daily error digest instead of publishing unchecked facts.
   ============================================================================ */

// Picks the next script that has a Stage-1 result but hasn't been verified yet.
function stage1b_verifyReadyScripts() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.SCRIPT);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if ((data[i][COL_SCRIPT.STATUS - 1] || "").toString() === "Ready") {
      stage1b_verifyFacts(data[i][COL_SCRIPT.ID - 1]);
      return; // one verification per tick — web_search calls are slow + billed
    }
  }
}

function stage1b_verifyFacts(scriptId) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.SCRIPT);
  const rowIdx = findRowIndexById_(SHEET.SCRIPT, scriptId, COL_SCRIPT.ID);
  if (rowIdx < 0) return false;

  const rankItems = JSON.parse(sh.getRange(rowIdx, COL_SCRIPT.RANK_ITEMS_JSON).getValue());
  const lean = rankItems.map(function (it) { return { rank: it.rank, name: it.name, fact: it.fact }; });

  const prompt =
    "You are fact-checking a ranking video BEFORE publication. For EACH item below, use web search to verify the claim.\n\n" +
    "Rules:\n" +
    "- If the claim is accurate, keep it but correct any numbers to match a reputable, current source.\n" +
    "- If it is wrong, outdated, or you cannot find a reputable source, REPLACE it with a DIFFERENT, specific, verifiable fact about the same item.\n" +
    "- Every item MUST include a real source URL you actually consulted.\n" +
    "- Each 'fact' = ONE punchy stat/claim, <= 14 words, no filler, no [VERIFY] tags.\n" +
    "- 'on_screen_text' = an even shorter caption version, <= 6 words.\n\n" +
    "Items:\n" + JSON.stringify(lean) + "\n\n" +
    "Respond with ONLY strict JSON as your final message (no prose, no code fences):\n" +
    '{"items":[{"rank":N,"name":"...","fact":"...","on_screen_text":"...","source":"https://..."}]}';

  try {
    const raw = callClaudeWithSearch(prompt, 8);
    const parsed = JSON.parse(extractJsonObject_(raw));
    if (!parsed.items || !parsed.items.length) throw new Error("Verifier returned no items");

    // Merge verified fields back onto the original items, matched by rank.
    const byRank = {};
    parsed.items.forEach(function (v) { byRank[v.rank] = v; });
    const verified = rankItems.map(function (it) {
      const v = byRank[it.rank];
      if (!v) throw new Error("Verifier skipped rank " + it.rank);
      if (!v.source || !/^https?:\/\//.test(v.source)) throw new Error("Missing source for rank " + it.rank);
      return {
        rank: it.rank,
        name: v.name || it.name,
        fact: v.fact || it.fact,
        on_screen_text: v.on_screen_text || it.on_screen_text || "",
        source: v.source
      };
    });

    sh.getRange(rowIdx, COL_SCRIPT.RANK_ITEMS_JSON).setValue(JSON.stringify(verified));
    sh.getRange(rowIdx, COL_SCRIPT.STATUS).setValue("Verified");
    return true;
  } catch (err) {
    logError("Stage 1.5 — Verification", scriptId, "Verify Error", err.message);
    sh.getRange(rowIdx, COL_SCRIPT.STATUS).setValue("Verify Failed");
    return false;
  }
}

// Row NUMBER (1-based) for a given id, or -1. (findRowById_ returns the row
// values; here we need the index to write back.)
function findRowIndexById_(sheetName, id, idCol) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][idCol - 1] === id) return i + 1;
  }
  return -1;
}

// Pulls the outermost {...} JSON object out of a text blob that may contain
// stray prose around it (web_search answers sometimes do).
function extractJsonObject_(text) {
  const clean = String(text).replace(/```json/g, "").replace(/```/g, "");
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) throw new Error("No JSON object in verifier response");
  return clean.slice(first, last + 1);
}
