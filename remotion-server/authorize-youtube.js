/* ============================================================================
   authorize-youtube.js — one-time YouTube upload authorization.

   Run ONCE:   node authorize-youtube.js   (from remotion-server/)

   It reuses oauth-client.json (your Desktop OAuth client), opens a consent URL
   for the YouTube UPLOAD + comment scopes, and after you sign in it PRINTS the
   three values Apps Script needs — paste them into Project Settings → Script
   Properties:
       YT_CLIENT_ID       YT_CLIENT_SECRET       YT_REFRESH_TOKEN

   IMPORTANT: sign in as the account that owns the YouTube CHANNEL you publish to.

   oauth-client.json is a gitignored secret. The printed refresh token is a
   secret too — don't share it or commit it.
   ============================================================================ */

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { URL } = require("url");

const OAUTH_CLIENT_PATH = process.env.DRIVE_OAUTH_CLIENT || path.join(__dirname, "oauth-client.json");
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",     // upload videos
  "https://www.googleapis.com/auth/youtube.force-ssl"   // post/pin the first comment
];
const PORT         = Number(process.env.YT_OAUTH_PORT) || 4748;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

function fail(msg) { console.error("\n❌ " + msg + "\n"); process.exit(1); }

(async () => {
  let google;
  try { ({ google } = require("googleapis")); }
  catch { fail("googleapis is not installed. Run:  npm install googleapis"); }

  if (!fs.existsSync(OAUTH_CLIENT_PATH)) {
    fail("OAuth client not found at:\n   " + OAUTH_CLIENT_PATH +
      "\n\nUse the same Desktop OAuth client JSON you used for Drive.");
  }

  const creds = JSON.parse(fs.readFileSync(OAUTH_CLIENT_PATH, "utf8"));
  const c = creds.installed || creds.web || creds;
  if (!c.client_id || !c.client_secret) fail("oauth-client.json is missing client_id/client_secret.");

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

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>✅ YouTube upload authorized.</h2><p>Copy the three values printed in your terminal into Apps Script Script Properties. You can close this tab.</p>");

      console.log("\n════════════════════════════════════════════════════════════════");
      console.log("  ✅ Paste these into Apps Script → Project Settings → Script Properties");
      console.log("════════════════════════════════════════════════════════════════\n");
      console.log("  YT_CLIENT_ID       " + c.client_id);
      console.log("  YT_CLIENT_SECRET   " + c.client_secret);
      console.log("  YT_REFRESH_TOKEN   " + tokens.refresh_token);
      console.log("\n(These are secrets — don't share or commit them.)\n");

      server.close(); setTimeout(() => process.exit(0), 200);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error: " + e.message);
      fail(e.message);
    }
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") fail(`Port ${PORT} is in use. Set YT_OAUTH_PORT to a free port and retry.`);
    fail(e.message);
  });

  server.listen(PORT, () => {
    console.log("\n────────────────────────────────────────────────────────────────");
    console.log("  RankingShorts YouTube upload authorization");
    console.log("────────────────────────────────────────────────────────────────");
    console.log("\n1) Open this URL and sign in as the account that OWNS your YouTube");
    console.log("   channel, then grant access:\n");
    console.log("   " + authUrl + "\n");
    console.log("2) After you approve, this terminal prints the 3 values to paste.");
    console.log("   (Waiting for the browser redirect on " + REDIRECT_URI + " …)\n");
  });
})();
