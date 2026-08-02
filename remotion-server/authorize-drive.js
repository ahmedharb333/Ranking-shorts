/* ============================================================================
   authorize-drive.js — one-time Google Drive authorization for the render server.

   Run ONCE:   node authorize-drive.js   (from governx-remotion/)

   It reads oauth-client.json (your "Desktop app" OAuth client), opens a consent
   URL, and after you sign in + grant Drive access, saves the refresh token to
   drive-token.json. drive-upload.js then uses that token to upload finished films
   to Drive as YOU — no service-account key (blocked org-wide), no storage-quota
   issue (you own the files).

   Both oauth-client.json and drive-token.json are gitignored secrets.
   ============================================================================ */

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { URL } = require("url");

const OAUTH_CLIENT_PATH = process.env.DRIVE_OAUTH_CLIENT || path.join(__dirname, "oauth-client.json");
const TOKEN_PATH        = process.env.DRIVE_OAUTH_TOKEN  || path.join(__dirname, "drive-token.json");
const SCOPES            = ["https://www.googleapis.com/auth/drive"];
const PORT              = Number(process.env.DRIVE_OAUTH_PORT) || 4747;
const REDIRECT_URI      = `http://localhost:${PORT}/oauth2callback`;

function fail(msg) { console.error("\n❌ " + msg + "\n"); process.exit(1); }

(async () => {
  let google;
  try { ({ google } = require("googleapis")); }
  catch { fail("googleapis is not installed. Run:  npm install googleapis"); }

  if (!fs.existsSync(OAUTH_CLIENT_PATH)) {
    fail("OAuth client not found at:\n   " + OAUTH_CLIENT_PATH +
      "\n\nIn Google Cloud Console → APIs & Services → Credentials → Create Credentials →\n" +
      "OAuth client ID → type 'Desktop app'. Download its JSON and save it there.");
  }

  const creds = JSON.parse(fs.readFileSync(OAUTH_CLIENT_PATH, "utf8"));
  const c = creds.installed || creds.web || creds;
  if (!c.client_id || !c.client_secret) fail("oauth-client.json is missing client_id/client_secret.");

  // Desktop-app clients allow loopback redirects on any port without pre-registration.
  const oAuth2 = new google.auth.OAuth2(c.client_id, c.client_secret, REDIRECT_URI);
  const authUrl = oAuth2.generateAuthUrl({
    access_type: "offline",   // request a refresh token
    prompt     : "consent",   // force a refresh_token even on re-auth
    scope      : SCOPES
  });

  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith("/oauth2callback")) { res.writeHead(204); res.end(); return; }
    try {
      const params = new URL(req.url, REDIRECT_URI).searchParams;
      const err = params.get("error");
      if (err) throw new Error("Consent was denied: " + err);
      const code = params.get("code");
      if (!code) throw new Error("No authorization code in the callback.");

      const { tokens } = await oAuth2.getToken(code);
      if (!tokens.refresh_token) {
        throw new Error("Google did not return a refresh_token. Revoke prior access at " +
          "https://myaccount.google.com/permissions and run this again (it forces consent).");
      }
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>✅ RankingShorts Drive authorized.</h2><p>Refresh token saved. You can close this tab and return to the terminal.</p>");
      console.log("\n✅ Saved refresh token to:\n   " + TOKEN_PATH +
        "\n\nDrive upload is now configured. Restart the render server (npm start) to pick it up.\n");
      server.close(); setTimeout(() => process.exit(0), 200);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error: " + e.message);
      fail(e.message);
    }
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") fail(`Port ${PORT} is in use. Set DRIVE_OAUTH_PORT to a free port and retry.`);
    fail(e.message);
  });

  server.listen(PORT, () => {
    console.log("\n────────────────────────────────────────────────────────────────");
    console.log("  RankingShorts Drive authorization");
    console.log("────────────────────────────────────────────────────────────────");
    console.log("\n1) Open this URL in your browser and sign in as the account that");
    console.log("   OWNS your Drive production folder, then grant Drive access:\n");
    console.log("   " + authUrl + "\n");
    console.log("2) After you approve, this window will confirm and save the token.");
    console.log("   (Waiting for the browser redirect on " + REDIRECT_URI + " …)\n");
  });
})();
