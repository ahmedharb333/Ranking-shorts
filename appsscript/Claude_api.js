/* ============================================================================
   Claude_api.js — RankingShorts Content OS
   Same retry/backoff pattern as GovernX's claude_api.gs, trimmed down since
   these are short single-call stages (no multi-thousand-word scripts).
   ============================================================================ */

const STAGE_EFFORT = {
  "stage0_topic_pick" : "low",     // pick next topic from queue — cheap
  "stage1_script"     : "medium",  // ranking script — needs some judgment
  "stage4_metadata"   : "low",     // YouTube title/desc/tags — formatting task
  "default"           : "medium"
};

function callClaude(finalPrompt, stageKey) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing from Script Properties");

  const effort = STAGE_EFFORT[stageKey] || STAGE_EFFORT["default"];
  const MAX_TRIES = 3;
  const RETRY_WAIT_MS = 5000;
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const payload = {
        model: ANTHROPIC_MODEL,
        max_tokens: 4000,
        system: [{ type: "text", text: SYSTEM_CONTEXT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: finalPrompt }],
        output_config: { effort: effort }
      };

      const res = UrlFetchApp.fetch(ANTHROPIC_API_URL, {
        method: "post",
        contentType: "application/json",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      const code = res.getResponseCode();
      const body = res.getContentText();

      if (code === 429) {
        Utilities.sleep(15000);
        continue;
      }
      if (code !== 200) {
        lastError = "HTTP " + code + ": " + body.slice(0, 500);
        Utilities.sleep(RETRY_WAIT_MS);
        continue;
      }

      const data = JSON.parse(body);
      const textBlock = (data.content || []).find(function (b) { return b.type === "text"; });
      if (!textBlock || !textBlock.text) {
        lastError = "Empty response from Claude";
        Utilities.sleep(RETRY_WAIT_MS);
        continue;
      }
      return textBlock.text;

    } catch (err) {
      lastError = err.message;
      Utilities.sleep(RETRY_WAIT_MS);
    }
  }

  throw new Error("callClaude failed after " + MAX_TRIES + " attempts: " + lastError);
}

// Strips ```json fences if Claude wraps its JSON output despite instructions.
function parseClaudeJson(raw) {
  const clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(clean);
}

// Like callClaude, but enables Anthropic's server-side web_search tool so
// Claude can ground answers in live sources. Used by the fact-verification
// stage. Returns the concatenated final text (the JSON answer).
function callClaudeWithSearch(finalPrompt, maxSearches) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing from Script Properties");

  const MAX_TRIES = 3;
  const RETRY_WAIT_MS = 5000;
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const payload = {
        model: ANTHROPIC_MODEL,
        max_tokens: 4000,
        system: [{ type: "text", text: SYSTEM_CONTEXT, cache_control: { type: "ephemeral" } }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearches || 8 }],
        messages: [{ role: "user", content: finalPrompt }]
      };

      const res = UrlFetchApp.fetch(ANTHROPIC_API_URL, {
        method: "post",
        contentType: "application/json",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      const code = res.getResponseCode();
      const body = res.getContentText();

      if (code === 429) { Utilities.sleep(15000); continue; }
      if (code !== 200) { lastError = "HTTP " + code + ": " + body.slice(0, 500); Utilities.sleep(RETRY_WAIT_MS); continue; }

      const data = JSON.parse(body);
      // web_search is a server tool; the model may interleave tool-result blocks
      // with text. The JSON answer is in the text blocks — concatenate them.
      const text = (data.content || [])
        .filter(function (b) { return b.type === "text" && b.text; })
        .map(function (b) { return b.text; })
        .join("\n")
        .trim();
      if (!text) { lastError = "Empty text from Claude (search)"; Utilities.sleep(RETRY_WAIT_MS); continue; }
      return text;

    } catch (err) {
      lastError = err.message;
      Utilities.sleep(RETRY_WAIT_MS);
    }
  }

  throw new Error("callClaudeWithSearch failed after " + MAX_TRIES + " attempts: " + lastError);
}
