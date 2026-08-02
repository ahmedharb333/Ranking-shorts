/* ============================================================================
   drive-upload.js — RankingShorts Remotion Server
   Uploads rendered MP4s directly to Google Drive, STREAMED (flat memory at any
   file size) — same pattern as GovernX. This is why Assembly.js in Apps Script
   never has to download the video itself: it just reads the driveUrl back.

   AUTH: OAuth user credentials (not a service account) — the server acts AS
   your Google account, so files are owned by you.

   SETUP (one time):
   1. Google Cloud Console → Credentials → Create Credentials → OAuth client ID
      → type "Desktop app". Download its JSON → save as:
         remotion-server/oauth-client.json
   2. In remotion-server/, run:  node authorize-drive.js
      Sign in, grant Drive access. Saves remotion-server/drive-token.json.
   3. Set DRIVE_FOLDER_ID in .env to your production folder's ID.
   ============================================================================ */

const fs   = require("fs");
const path = require("path");

const OAUTH_CLIENT_PATH = process.env.DRIVE_OAUTH_CLIENT || path.join(__dirname, "oauth-client.json");
const TOKEN_PATH        = process.env.DRIVE_OAUTH_TOKEN  || path.join(__dirname, "drive-token.json");

const _folderRaw = (process.env.DRIVE_FOLDER_ID || "").trim();
const PRODUCTION_FOLDER_ID = _folderRaw === "your_production_folder_id_here" ? "" : _folderRaw;

function getDriveClient() {
  const { google } = require("googleapis"); // lazy load — server still starts without it installed
  if (!fs.existsSync(OAUTH_CLIENT_PATH)) {
    throw new Error("OAuth client not found at: " + OAUTH_CLIENT_PATH +
      "\nCreate an OAuth client ID (Desktop app) in Google Cloud Console and save its JSON there.");
  }
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error("Drive not authorized yet. Run:  node authorize-drive.js");
  }
  const creds = JSON.parse(fs.readFileSync(OAUTH_CLIENT_PATH, "utf8"));
  const c = creds.installed || creds.web || creds;
  const oAuth2 = new google.auth.OAuth2(c.client_id, c.client_secret);
  oAuth2.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
  return google.drive({ version: "v3", auth: oAuth2 });
}

async function uploadToDrive(localFilePath, filename, contentId) {
  const drive = getDriveClient();
  const contentFolderId = await getOrCreateContentFolder(drive, contentId);
  // Final render goes in a "final video" subfolder alongside the source assets.
  const finalFolderId = await getOrCreateChildFolder(drive, contentFolderId, "final video");
  await deleteExistingFile(drive, filename, finalFolderId);

  const response = await drive.files.create({
    requestBody: { name: filename, parents: [finalFolderId], mimeType: "video/mp4" },
    media: { mimeType: "video/mp4", body: fs.createReadStream(localFilePath) },
    fields: "id,name,webViewLink,webContentLink",
    supportsAllDrives: true
  });

  const file = response.data;
  await drive.permissions.create({
    fileId: file.id,
    requestBody: { role: "reader", type: "anyone" },
    supportsAllDrives: true
  });

  return {
    fileId: file.id,
    fileName: file.name,
    driveUrl: file.webViewLink,
    downloadUrl: `https://drive.google.com/uc?id=${file.id}&export=download`
  };
}

async function getOrCreateContentFolder(drive, contentId) {
  if (!PRODUCTION_FOLDER_ID) {
    throw new Error("DRIVE_FOLDER_ID not set. Set it in .env: DRIVE_FOLDER_ID=your_folder_id");
  }
  const id = String(contentId || "").trim();
  // Same per-video folder Apps Script creates for the source assets, so both
  // sides converge on one folder per video.
  return getOrCreateChildFolder(drive, PRODUCTION_FOLDER_ID, id);
}

// Find-or-create a folder named `name` directly under `parentId`.
async function getOrCreateChildFolder(drive, parentId, name) {
  const safe = String(name).replace(/'/g, "\\'");
  const search = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false and name='${safe}'`,
    fields: "files(id,name)",
    spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 10
  });
  const match = (search.data.files || []).find((f) => f.name === name);
  if (match) return match.id;

  const folder = await drive.files.create({
    requestBody: { name: name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    fields: "id",
    supportsAllDrives: true
  });
  return folder.data.id;
}

async function deleteExistingFile(drive, filename, folderId) {
  try {
    const search = await drive.files.list({
      q: `name='${filename}' and '${folderId}' in parents and trashed=false`,
      fields: "files(id)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    for (const file of search.data.files || []) {
      await drive.files.delete({ fileId: file.id, supportsAllDrives: true });
    }
  } catch (e) {
    console.log("[Drive] Could not delete existing file (non-fatal):", e.message);
  }
}

function isDriveConfigured() {
  if (!fs.existsSync(OAUTH_CLIENT_PATH) || !fs.existsSync(TOKEN_PATH) || !PRODUCTION_FOLDER_ID) return false;
  try { require.resolve("googleapis"); return true; }
  catch { return false; }
}

// True when we can *authenticate* to Drive (download doesn't need a
// production folder, unlike uploads — hence a lighter check than isDriveConfigured).
function isDriveAuthAvailable() {
  if (!fs.existsSync(OAUTH_CLIENT_PATH) || !fs.existsSync(TOKEN_PATH)) return false;
  try { require.resolve("googleapis"); return true; }
  catch { return false; }
}

// Pull a Drive file ID out of the URL forms our pipeline produces:
//   https://drive.google.com/uc?id=XXX  (Visuals.js saveUrlToDrive_)
//   https://drive.google.com/file/d/XXX/view  (webViewLink)
function extractDriveFileId(url) {
  if (!url) return null;
  const uc = String(url).match(/[?&]id=([^&]+)/);
  if (uc) return uc[1];
  const view = String(url).match(/\/d\/([^/]+)/);
  if (view) return view[1];
  return null;
}

// Download a Drive file to destPath using the authenticated client. Drive media
// URLs can't be loaded directly by Remotion's headless Chrome (ORB/403), so the
// render server fetches them itself and serves them over http://localhost.
async function downloadFromDrive(fileId, destPath) {
  const drive = getDriveClient();
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" }
  );
  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(destPath);
    res.data.on("error", reject).pipe(dest).on("error", reject).on("finish", resolve);
  });
  return destPath;
}

module.exports = { uploadToDrive, isDriveConfigured, isDriveAuthAvailable, extractDriveFileId, downloadFromDrive };
