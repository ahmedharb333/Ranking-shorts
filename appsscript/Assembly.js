/* ============================================================================
   Assembly.js — RankingShorts Content OS
   Stage 4: submits a render job to the LOCAL Remotion server (see
   /remotion-server) and polls for completion — same async job+poll pattern
   as GovernX's real server/index.js /assemble/job endpoint.

   IMPORTANT: the render server uploads the finished MP4 DIRECTLY to Google
   Drive itself (drive-upload.js, streamed via OAuth), so this file never
   downloads the video through UrlFetchApp — that step used to hit a hard
   50MB response cap on longer renders. We just read back the driveUrl.
   ============================================================================ */

function stage4_submitAssembly(scriptId) {
  const serverBase = PropertiesService.getScriptProperties().getProperty("REMOTION_SERVER_URL");
  if (!serverBase) throw new Error("REMOTION_SERVER_URL not set — is your local server + ngrok running?");

  const scriptRow = findRowById_(SHEET.SCRIPT, scriptId, COL_SCRIPT.ID);
  const rankItems = JSON.parse(scriptRow[COL_SCRIPT.RANK_ITEMS_JSON - 1]);
  const title = scriptRow[COL_SCRIPT.TITLE - 1];

  const visualRows = SpreadsheetApp.getActive().getSheetByName(SHEET.VISUAL)
    .getDataRange().getValues().filter(function (r) { return r[COL_VISUAL.ID - 1] === scriptId; });
  const audioRows = SpreadsheetApp.getActive().getSheetByName(SHEET.AUDIO)
    .getDataRange().getValues().filter(function (r) { return r[COL_AUDIO.ID - 1] === scriptId; });

  function audioFor(idx) {
    const a = audioRows.find(function (r) { return Number(r[COL_AUDIO.RANK_ITEM_IDX - 1]) === idx; });
    return a ? { audioUrl: a[COL_AUDIO.AUDIO_URL - 1], audioDurationSec: a[COL_AUDIO.DURATION_SEC - 1] } : { audioUrl: "", audioDurationSec: 4 };
  }

  // Uniform scenes[] array — matches the real server's expected shape.
  // type: "hook" | "rank" | "cta". Only "rank" scenes carry a background clip.
  const hookAudio = audioFor(0);
  const ctaAudio = audioFor(99);
  const scenes = [
    { type: "hook", onScreenText: scriptRow[COL_SCRIPT.HOOK - 1], audioUrl: hookAudio.audioUrl, audioDurationSec: hookAudio.audioDurationSec }
  ].concat(rankItems.map(function (item, idx) {
    const visual = visualRows.find(function (v) { return Number(v[COL_VISUAL.RANK_ITEM_IDX - 1]) === idx; });
    const audio = audioFor(item.rank);
    return {
      type: "rank",
      rank: item.rank,
      name: item.name,
      onScreenText: item.on_screen_text,
      clipUrl: visual ? visual[COL_VISUAL.CLIP_URL - 1] : "",
      audioUrl: audio.audioUrl,
      audioDurationSec: audio.audioDurationSec
    };
  })).concat([
    { type: "cta", onScreenText: scriptRow[COL_SCRIPT.CTA - 1], audioUrl: ctaAudio.audioUrl, audioDurationSec: ctaAudio.audioDurationSec }
  ]);

  const res = UrlFetchApp.fetch(serverBase + "/assemble/job", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ contentId: scriptId, title: title, scenes: scenes }),
    muteHttpExceptions: true
  });

  const data = JSON.parse(res.getContentText());
  if (!data.ok || !data.jobId) throw new Error("Render server rejected job: " + res.getContentText().slice(0, 300));

  const assemblySh = SpreadsheetApp.getActive().getSheetByName(SHEET.ASSEMBLY);
  assemblySh.appendRow([scriptId, data.jobId, new Date(), "queued", "", ""]);
  return data.jobId;
}

// Called on every automation tick — checks any in-flight render jobs.
function stage4b_pollAssemblyJobs() {
  const serverBase = PropertiesService.getScriptProperties().getProperty("REMOTION_SERVER_URL");
  if (!serverBase) return;

  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET.ASSEMBLY);
  const data = sh.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const status = data[i][COL_ASSEMBLY.STATUS - 1];
    if (status === "done" || status === "error") continue;

    const jobId = data[i][COL_ASSEMBLY.JOB_ID - 1];
    try {
      const res = UrlFetchApp.fetch(serverBase + "/assemble/job/" + jobId, { muteHttpExceptions: true });
      const job = JSON.parse(res.getContentText());

      if (job.status === "done") {
        // Preferred path: server already uploaded straight to Drive.
        const driveUrl = job.drive && job.drive.driveUrl
          ? job.drive.driveUrl
          : saveUrlToDrive_(job.url, data[i][COL_ASSEMBLY.ID - 1] + ".mp4"); // fallback if Drive wasn't configured on the server
        sh.getRange(i + 1, COL_ASSEMBLY.STATUS).setValue("done");
        sh.getRange(i + 1, COL_ASSEMBLY.MP4_URL).setValue(driveUrl);
        if (job.driveError) sh.getRange(i + 1, COL_ASSEMBLY.NOTE).setValue("Drive upload issue: " + job.driveError);
      } else if (job.status === "error" || job.ok === false) {
        sh.getRange(i + 1, COL_ASSEMBLY.STATUS).setValue("error");
        sh.getRange(i + 1, COL_ASSEMBLY.NOTE).setValue(job.error || "unknown render error");
        logError("Stage 4 — Assembly", data[i][COL_ASSEMBLY.ID - 1], "Render Error", job.error || "");
      }
      // else still "running" — leave as-is, checked again next tick
    } catch (err) {
      logError("Stage 4 — Assembly Poll", jobId, "Poll Error", err.message);
    }
  }
}
