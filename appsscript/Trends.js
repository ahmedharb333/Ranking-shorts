/* ============================================================================
   Trends.js — RankingShorts Content OS
   LEGAL trend signals for the Stage 0 topic picker: what's performing on
   YouTube (official Data API) + rising Google Trends related queries. These
   feed Claude as *inspiration* — the dedup layers still guarantee no repeats.

   Everything here is FAIL-SOFT: any error returns [] so topic generation is
   never blocked by a flaky trend source.

   Keys:
   - YOUTUBE_API_KEY (Script Property, optional) — a YouTube Data API v3 key
     from the same Google Cloud project as your upload OAuth. Without it, the
     YouTube signal is skipped.  (Google Trends needs no key.)
   ============================================================================ */

// Combined, labeled trend signals for a niche (few from each source).
function getTrendSignals_(niche) {
  const out = [];
  youtubeTrendTitles_(niche).slice(0, 8).forEach(function (t) { out.push("YouTube top: " + t); });
  googleTrendsRelated_(nicheKeyword_(niche)).slice(0, 8).forEach(function (t) { out.push("Rising search: " + t); });
  return out;
}

function nicheKeyword_(niche) {
  const map = { "Food": "street food", "Places": "places to visit", "Countries": "best countries to live" };
  return map[niche] || String(niche || "");
}

// Titles of the highest-viewed recent YouTube videos for the niche (official
// Data API search, read-only). Needs YOUTUBE_API_KEY; returns [] without it.
function youtubeTrendTitles_(niche) {
  try {
    const key = PropertiesService.getScriptProperties().getProperty("YOUTUBE_API_KEY");
    if (!key) return [];
    const q = encodeURIComponent(niche + " ranking");
    const after = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(); // last 90 days
    const url = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount" +
      "&maxResults=10&q=" + q + "&publishedAfter=" + after + "&key=" + key;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const data = JSON.parse(res.getContentText());
    return (data.items || [])
      .map(function (it) { return it.snippet && it.snippet.title; })
      .filter(function (x) { return x; });
  } catch (e) {
    return [];
  }
}

// Rising "related queries" for a keyword from Google Trends' (unofficial) API.
// Best-effort — Google can change this endpoint; on any failure returns [].
function googleTrendsRelated_(keyword) {
  try {
    if (!keyword) return [];
    const base = "https://trends.google.com/trends/api";
    const exploreReq = JSON.stringify({
      comparisonItem: [{ keyword: keyword, geo: "", time: "today 3-m" }],
      category: 0, property: ""
    });
    const opts = { muteHttpExceptions: true, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } };
    const exploreUrl = base + "/explore?hl=en-US&tz=0&req=" + encodeURIComponent(exploreReq);
    const exploreJson = JSON.parse(stripTrendsPrefix_(
      UrlFetchApp.fetch(exploreUrl, opts).getContentText()));
    const widget = (exploreJson.widgets || []).find(function (w) { return w.id === "RELATED_QUERIES"; });
    if (!widget || !widget.token) return [];

    const dataUrl = base + "/widgetdata/relatedsearches?hl=en-US&tz=0&req=" +
      encodeURIComponent(JSON.stringify(widget.request)) + "&token=" + encodeURIComponent(widget.token);
    const dataJson = JSON.parse(stripTrendsPrefix_(
      UrlFetchApp.fetch(dataUrl, opts).getContentText()));

    const lists = (dataJson.default && dataJson.default.rankedList) || [];
    const out = [];
    lists.forEach(function (l) {
      (l.rankedKeyword || []).forEach(function (k) { if (k.query) out.push(k.query); });
    });
    return out.slice(0, 10);
  } catch (e) {
    return [];
  }
}

// Google Trends responses are prefixed with ")]}'," before the JSON body.
function stripTrendsPrefix_(text) {
  const i = String(text).indexOf("{");
  return i >= 0 ? String(text).slice(i) : String(text);
}
