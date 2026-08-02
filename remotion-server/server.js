/* ============================================================================
   server.js — RankingShorts local Remotion render server
   Mirrors GovernX's real server/index.js pattern: async job + poll, then a
   streamed direct-to-Drive upload (drive-upload.js) so Apps Script never has
   to download the MP4 itself (avoids the 50MB UrlFetchApp cap).

   Run with: npm install && npm start
   Then expose it: ngrok http 3000
   Paste the ngrok URL into Apps Script Script Property REMOTION_SERVER_URL.
   ============================================================================ */

const express = require("express");
const path = require("path");
const fs = require("fs");
try { require("dotenv").config({ path: path.join(__dirname, ".env") }); } catch (e) {}

const { bundle } = require("@remotion/bundler");
const { renderMedia, selectComposition } = require("@remotion/renderer");
const driveUpload = require("./drive-upload");

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS for Apps Script / ngrok
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, ngrok-skip-browser-warning");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const CLIPS_DIR = path.join(__dirname, "clips"); // Drive clips downloaded here, then served over localhost to the renderer
if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });

// Drive-hosted clip URLs (drive.google.com/uc?id=... from Visuals.js) can't be
// loaded by Remotion's headless Chrome (ORB/403). Download them via the
// authenticated Drive client and hand the renderer a localhost URL instead.
// Non-Drive URLs (e.g. Pexels CDN) are returned unchanged — they load fine.
async function resolveClipUrl(clipUrl) {
  if (!clipUrl || !/drive\.google\.com/.test(clipUrl)) return clipUrl;
  const fileId = driveUpload.extractDriveFileId(clipUrl);
  if (!fileId) return clipUrl;
  if (!driveUpload.isDriveAuthAvailable()) {
    console.warn(`[clips] Drive clip ${clipUrl} needs auth to download but Drive is not authorized — leaving as-is (render will likely fail).`);
    return clipUrl;
  }
  const localName = `${fileId}.mp4`;
  const localPath = path.join(CLIPS_DIR, localName);
  if (!fs.existsSync(localPath)) {
    console.log(`[clips] downloading Drive clip ${fileId} -> clips/${localName}`);
    await driveUpload.downloadFromDrive(fileId, localPath);
  }
  return `http://localhost:${PORT}/clips/${localName}`;
}

const jobs = new Map(); // jobId -> { status, startedAt, result, error }

let bundlePromise = null;
function getBundleLocation() {
  if (!bundlePromise) {
    console.log("[RankingShorts] Bundling Remotion project...");
    bundlePromise = bundle({ entryPoint: path.join(__dirname, "src", "Root.tsx") }).then((loc) => {
      console.log("[RankingShorts] Bundle ready.");
      return loc;
    }).catch((err) => {
      bundlePromise = null; // allow retry on next job if bundling itself failed
      throw err;
    });
  }
  return bundlePromise;
}

app.get("/health", (req, res) => res.json({ status: "ok", server: "RankingShorts Remotion Renderer" }));

// POST /assemble/job  { contentId, scenes: [{type,rank,name,onScreenText,clipUrl,audioUrl,audioDurationSec}], title }
app.post("/assemble/job", (req, res) => {
  const { contentId, scenes, title } = req.body || {};
  if (!contentId || !Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ ok: false, error: "contentId and non-empty scenes[] required" });
  }

  const jobId = "job_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  jobs.set(jobId, { status: "running", startedAt: Date.now(), result: null, error: "" });
  res.json({ ok: true, jobId });

  (async () => {
    const serveUrl = await getBundleLocation();

    // Resolve any Drive-hosted clip URLs to locally-served copies before render.
    const rankScenes = scenes.filter((s) => s.type === "rank");
    for (const s of rankScenes) {
      s.clipUrl = await resolveClipUrl(s.clipUrl);
    }

    const inputProps = { title: title || contentId, hook: scenes.find((s) => s.type === "hook")?.onScreenText || "",
      hookAudioUrl: scenes.find((s) => s.type === "hook")?.audioUrl || "",
      ctaAudioUrl: scenes.find((s) => s.type === "cta")?.audioUrl || "",
      scenes: rankScenes };

    const composition = await selectComposition({ serveUrl, id: "RankingVideo", inputProps });
    const filename = `${contentId}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, filename);

    await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: outputPath, inputProps });

    const bytes = fs.statSync(outputPath).size;

    let drive = null, driveError = "";
    if (driveUpload.isDriveConfigured()) {
      try {
        drive = await driveUpload.uploadToDrive(outputPath, filename, contentId);
        console.log(`[Assemble ${contentId}] uploaded to Drive -> ${drive.driveUrl}`);
      } catch (e) {
        driveError = e.message;
        console.error(`[Assemble ${contentId}] Drive upload failed: ${e.message}`);
      }
    } else {
      console.log(`[Assemble ${contentId}] Drive not configured -- serving locally via ngrok instead.`);
    }

    return {
      filename,
      url: `http://localhost:${PORT}/output/${filename}`, // becomes reachable via your ngrok URL
      bytes,
      drive,
      driveError
    };
  })()
    .then((result) => jobs.set(jobId, { status: "done", startedAt: Date.now(), result, error: "" }))
    .catch((err) => jobs.set(jobId, { status: "error", startedAt: Date.now(), result: null, error: err.message }));
});

app.get("/assemble/job/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "unknown jobId" });
  if (job.status === "running") return res.json({ ok: true, status: "running", elapsedMs: Date.now() - job.startedAt });
  if (job.status === "error") return res.json({ ok: false, status: "error", error: job.error });
  res.json({ ok: true, status: "done", ...job.result });
});

app.use("/output", express.static(OUTPUT_DIR));
app.use("/clips", express.static(CLIPS_DIR));

app.listen(PORT, () => {
  console.log(`RankingShorts render server listening on :${PORT}`);
  console.log(`Run "ngrok http ${PORT}" and set REMOTION_SERVER_URL to the ngrok URL.`);
});
