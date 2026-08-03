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

  // Opinion pieces (angle "perspective") are judged differently: subjective
  // picks don't need a source, but any concrete factual claim still must.
  const ideaRow = findRowById_(SHEET.IDEA, scriptId, COL_IDEA.ID);
  const angle = ideaRow ? String(ideaRow[COL_IDEA.ANGLE - 1] || "") : "";
  const isPerspective = angle.toLowerCase() === "perspective";

  // How many times we've already tried to verify this script (stored in Note).
  const noteVal = String(sh.getRange(rowIdx, COL_SCRIPT.NOTE).getValue() || "");
  const attempt = ((parseInt((noteVal.match(/verify_attempt=(\d+)/) || [])[1], 10) || 0)) + 1;

  const rankItems = JSON.parse(sh.getRange(rowIdx, COL_SCRIPT.RANK_ITEMS_JSON).getValue());
  const lean = rankItems.map(function (it) { return { rank: it.rank, name: it.name, fact: it.fact }; });

  // Structured knowledge bank (World Bank / USDA) as authoritative grounding.
  const niche = sh.getRange(rowIdx, COL_SCRIPT.NICHE).getValue();
  let pack = "";
  try { pack = fetchKnowledgePack_(niche, lean); } catch (e) { pack = ""; }
  const grounding = pack
    ? "AUTHORITATIVE DATA — prefer these figures and cite the given Source URL when you use one; only web-search for what they don't cover:\n" + pack + "\n\n"
    : "";

  const head = "You are fact-checking a ranking video BEFORE publication.\n\n" + grounding + "Items:\n" + JSON.stringify(lean) + "\n\n";
  const tail =
    "\nEach 'fact' <= 14 words, no filler, no [VERIFY] tags. 'on_screen_text' <= 6 words.\n" +
    "Each item also needs a clean 'search_query' (3-6 words) — the ACTUAL food/place/object to show on screen for stock/AI visuals, NO numbers, NO units, NO obscure brand names (e.g. 'close-up spicy chicken wings'). Rewrite it for any item you replace.\n" +
    "ALSO return an updated 'hook' — one punchy line that works muted, ABOUT the FINAL #1 item, using ITS verified number, so the hook can never contradict the ranking.\n" +
    "Respond with ONLY strict JSON as your final message (no prose, no code fences):\n" +
    '{"hook":"...","items":[{"rank":N,"name":"...","fact":"...","on_screen_text":"...","search_query":"...","source":"https://..."}]}';

  const prompt = isPerspective
    ? head +
      "This is a PERSPECTIVE / opinion ranking (subjective — no objective right answer). Rules:\n" +
      "- Subjective preferences/opinions are allowed and need NO source; set \"source\":\"\" for those.\n" +
      "- BUT any concrete factual claim (price, date, law, record, statistic) MUST be verified with web search and corrected, or removed if false — those MUST carry a real source URL.\n" +
      "- Keep the opinionated, first-person framing." + tail
    : head +
      "For EACH item, use web search to verify the claim. Rules:\n" +
      "- If accurate, keep it but correct any numbers to a reputable, current source.\n" +
      "- If wrong, outdated, or unsourceable, REPLACE it with a DIFFERENT, specific, verifiable fact about the same item.\n" +
      "- HARD RULE: NEVER return an item without a real source URL. If after searching you cannot source a claim, swap the whole item for a DIFFERENT one (a different food/place/country that fits the ranking) that you CAN source — do not leave anything unsourced.\n" +
      "- Every item MUST include a real source URL you actually consulted.\n" +
      "- CRITICAL — keep the RANKING internally consistent: the video ranks items by ONE metric (e.g. price). After correcting values, SORT the items by that metric so rank 1 is the MOST extreme (e.g. most expensive) and renumber ranks 1..N accordingly. If a corrected value no longer fits the ranking premise (e.g. it's actually cheap in a 'most expensive' list), REPLACE that item with a different verifiable one that DOES fit, so the numbers never contradict the rank order." + tail;

  try {
    const raw = callClaudeWithSearch(prompt, 5); // cap web searches so verification stays well under Apps Script's 6-min limit
    const parsed = JSON.parse(extractJsonObject_(raw));
    if (!parsed.items || !parsed.items.length) throw new Error("Verifier returned no items");

    // Trust the verifier's (possibly re-ranked/replaced) items so the ranking
    // stays consistent. Validate, drop unsourced non-perspective items, sort by
    // the verifier's rank, then renumber 1..N to close any gaps.
    const verified = parsed.items
      .filter(function (v) { return v && v.name && v.fact; })
      .map(function (v) {
        const hasSource = v.source && /^https?:\/\//.test(v.source);
        if (!isPerspective && !hasSource) return null; // sourced facts required
        return {
          rank: Number(v.rank) || 999,
          name: v.name,
          fact: v.fact,
          on_screen_text: v.on_screen_text || "",
          search_query: v.search_query || v.name,
          source: hasSource ? v.source : ""
        };
      })
      .filter(function (x) { return x; })
      .sort(function (a, b) { return a.rank - b.rank; });

    if (verified.length < Math.min(3, rankItems.length)) {
      throw new Error("Too few verified items (" + verified.length + " of " + rankItems.length + ")");
    }
    verified.forEach(function (it, i) { it.rank = i + 1; }); // renumber #1..#N, #1 = most extreme

    sh.getRange(rowIdx, COL_SCRIPT.RANK_ITEMS_JSON).setValue(JSON.stringify(verified));
    // Keep the hook in sync with the (possibly re-ranked/corrected) #1 item.
    if (parsed.hook && String(parsed.hook).trim()) {
      sh.getRange(rowIdx, COL_SCRIPT.HOOK).setValue(String(parsed.hook).trim());
    }
    sh.getRange(rowIdx, COL_SCRIPT.STATUS).setValue("Verified");
    sh.getRange(rowIdx, COL_SCRIPT.NOTE).setValue(""); // clear the retry marker
    return true;
  } catch (err) {
    logError("Stage 1.5 — Verification", scriptId, "Verify Error (attempt " + attempt + ")", err.message);
    if (attempt < MAX_VERIFY_ATTEMPTS) {
      // Keep the check tight but don't give up — re-verify next tick with a
      // fresh web search (new sources), leaving Status "Ready" so it's re-picked.
      sh.getRange(rowIdx, COL_SCRIPT.STATUS).setValue("Ready");
      sh.getRange(rowIdx, COL_SCRIPT.NOTE).setValue("verify_attempt=" + attempt +
        " — retrying with fresh sources (" + err.message.slice(0, 60) + ")");
    } else {
      // Genuinely unverifiable after several honest tries — park for review so
      // it never publishes unverified and never loops forever.
      sh.getRange(rowIdx, COL_SCRIPT.STATUS).setValue("Verify Failed");
      sh.getRange(rowIdx, COL_SCRIPT.NOTE).setValue("verify_attempt=" + attempt +
        " — gave up after " + MAX_VERIFY_ATTEMPTS + " attempts (" + err.message.slice(0, 60) + ")");
    }
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
