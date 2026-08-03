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

// Localize media so the renderer never depends on a slow/blocked remote host:
//  - Drive URLs can't be loaded by headless Chrome (ORB/403) — download via the
//    authenticated Drive client.
//  - IMAGES from any http host are downloaded too (Remotion <Img> has a
//    delayRender timeout; a slow image host like an on-demand generator would
//    time out the render).
//  - Video URLs from non-Drive CDNs (e.g. Pexels) load fine directly.
async function resolveClipUrl(clipUrl, mediaType) {
  if (!clipUrl || !/^https?:\/\//.test(clipUrl)) return clipUrl;
  const isDrive = /drive\.google\.com/.test(clipUrl);
  const isImage = mediaType === "image";

  // Non-Drive videos load directly.
  if (!isDrive && !isImage) return clipUrl;

  try {
    const ext = isImage ? ".jpg" : ".mp4";
    const fileId = isDrive ? driveUpload.extractDriveFileId(clipUrl) : null;
    const localName = (fileId || "img_" + hashString_(clipUrl)) + ext;
    const localPath = path.join(CLIPS_DIR, localName);
    if (!fs.existsSync(localPath)) {
      if (isDrive) {
        if (!fileId || !driveUpload.isDriveAuthAvailable()) return clipUrl;
        console.log(`[clips] downloading Drive ${mediaType || "video"} ${fileId} -> clips/${localName}`);
        await driveUpload.downloadFromDrive(fileId, localPath);
      } else {
        console.log(`[clips] downloading remote image -> clips/${localName}`);
        await httpDownload_(clipUrl, localPath);
      }
    }
    return `http://localhost:${PORT}/clips/${localName}`;
  } catch (e) {
    // For images, degrade gracefully: an empty clipUrl renders a black scene
    // (rank/name/caption still show) so ONE bad AI image can't fail the video.
    console.warn(`[clips] localize failed (${e.message}) — ${isImage ? "rendering black for this scene" : "using remote URL"}`);
    return isImage ? "" : clipUrl;
  }
}

// Download an image, validating it's actually an image (Pollinations sometimes
// returns a 200 with an error/empty body). Retries — it's flaky.
async function httpDownload_(url, dest) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (res.ok && ct.indexOf("image/") === 0) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 1500) { fs.writeFileSync(dest, buf); return; } // a real image
      }
    } catch (e) { /* fall through to retry */ }
    await new Promise(function (r) { setTimeout(r, 1500); });
  }
  throw new Error("no valid image returned after 3 tries");
}

function hashString_(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
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
      s.clipUrl = await resolveClipUrl(s.clipUrl, s.mediaType);
    }

    const hookScene = scenes.find((s) => s.type === "hook");
    const ctaScene = scenes.find((s) => s.type === "cta");
    const inputProps = { title: title || contentId, hook: hookScene?.onScreenText || "",
      hookAudioUrl: hookScene?.audioUrl || "",
      ctaAudioUrl: ctaScene?.audioUrl || "",
      hookAudioDurationSec: hookScene?.audioDurationSec || 0,
      ctaAudioDurationSec: ctaScene?.audioDurationSec || 0,
      scenes: rankScenes };

    const composition = await selectComposition({ serveUrl, id: "RankingVideo", inputProps, timeoutInMilliseconds: 60000 });
    const filename = `${contentId}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, filename);

    await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: outputPath, inputProps, timeoutInMilliseconds: 60000 });

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
