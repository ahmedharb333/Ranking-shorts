/* ============================================================================
   Voiceover.js — RankingShorts Content OS
   Stage 3: Splits the script into hook / per-item / outro lines and sends
   each to ElevenLabs, saving timed audio clips to Drive.
   ============================================================================ */

function stage3_generateVoiceover(scriptId) {
  const row = findRowById_(SHEET.SCRIPT, scriptId, COL_SCRIPT.ID);
  if (!row) return false;

  const rankItems = JSON.parse(row[COL_SCRIPT.RANK_ITEMS_JSON - 1]);
  const hook = row[COL_SCRIPT.HOOK - 1];
  const cta = row[COL_SCRIPT.CTA - 1];
  const audioSh = SpreadsheetApp.getActive().getSheetByName(SHEET.AUDIO);

  const lines = [{ idx: 0, text: hook }]
    .concat(rankItems.map(function (item) { return { idx: item.rank, text: item.fact }; }))
    .concat([{ idx: 99, text: cta }]);

  lines.forEach(function (line) {
    try {
      const clean = cleanTtsText_(line.text);
      if (!clean) return; // nothing left to speak
      const audioUrl = synthesizeVoice_(clean, scriptId);
      const durationSec = estimateDurationSec_(clean);
      audioSh.appendRow([scriptId, line.idx, audioUrl, durationSec, "Ready"]);
    } catch (err) {
      logError("Stage 3 — Voiceover", scriptId, "TTS Error", err.message);
    }
  });

  return true;
}

// Removes internal review markers so they're never spoken aloud. Claude flags
// low-confidence claims with [VERIFY] (see SYSTEM_CONTEXT); without this the
// narrator literally reads "verify" after those facts. Strips bracketed/parens
// verify/verified/unverified tags and tidies spacing.
function cleanTtsText_(text) {
  return String(text || "")
    .replace(/[\[\(]\s*(?:un)?verif(?:y|ied)?\s*[\]\)]/gi, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function synthesizeVoice_(text, contentId) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("ELEVENLABS_API_KEY");
  const voiceId = PropertiesService.getScriptProperties().getProperty("ELEVENLABS_VOICE_ID");

  const res = UrlFetchApp.fetch(ELEVENLABS_API_URL + "/" + voiceId, {
    method: "post",
    contentType: "application/json",
    headers: { "xi-api-key": apiKey },
    payload: JSON.stringify({ text: text, model_id: ELEVENLABS_MODEL, voice_settings: ELEVENLABS_VOICE_SETTINGS }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    throw new Error("ElevenLabs error: " + res.getContentText().slice(0, 300));
  }

  const folder = getContentFolder_(contentId);
  const blob = res.getBlob().setName("vo_" + Utilities.getUuid().slice(0, 8) + ".mp3");
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return "https://drive.google.com/uc?id=" + file.getId();
}

// Rough estimate (~2.5 words/sec spoken) — the Remotion server re-measures the
// actual mp3 duration server-side and this is only used for sheet visibility.
function estimateDurationSec_(text) {
  const words = text.trim().split(/\s+/).length;
  return Math.round(words / 2.5 * 10) / 10;
}
