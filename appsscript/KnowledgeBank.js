/* ============================================================================
   KnowledgeBank.js — RankingShorts Content OS
   Structured "knowledge bank" for the fact-verification stage. For each niche
   we fetch authoritative data and hand it to Claude as grounding, so verified
   facts come from real datasets (cited as the source) instead of guesses.
   Everything here is FAIL-SOFT: any error returns "" and verification falls
   back to Claude's web_search — the pipeline never breaks on a data miss.

   Sources:
   - Countries  -> World Bank Open Data API (free, no key)
   - Food       -> USDA FoodData Central (free; needs Script Property USDA_API_KEY)
   - Places / cost-of-living / prices -> handled by web_search fallback
     (no free live per-city API exists; WhereNext is bulk-download only)
   ============================================================================ */

// Returns a grounding text block for the given niche + items, or "" if none.
function fetchKnowledgePack_(niche, items) {
  try {
    const n = String(niche || "").toLowerCase();
    if (n === "countries") return worldBankPack_(items);
    if (n === "food") return usdaPack_(items);
    return ""; // places & anything else -> web_search fallback
  } catch (e) {
    return "";
  }
}

// ── World Bank (Countries) ───────────────────────────────────────────────────
function worldBankPack_(items) {
  try {
    const isoMap = wbNameToIso_();
    const wanted = items
      .map(function (it) { return { name: it.name, iso: wbMatchIso_(isoMap, it.name) }; })
      .filter(function (x) { return x.iso; });
    if (!wanted.length) return "";

    const codes = wanted.map(function (x) { return x.iso; }).join(";");
    const indicators = [
      { code: "NY.GDP.PCAP.CD", label: "GDP per capita (US$)" },
      { code: "FP.CPI.TOTL.ZG", label: "inflation %" },
      { code: "SP.DYN.LE00.IN", label: "life expectancy (yrs)" },
      { code: "SP.POP.TOTL",    label: "population" }
    ];

    const byIso = {};
    wanted.forEach(function (x) { byIso[x.iso] = { name: x.name, vals: {} }; });

    indicators.forEach(function (ind) {
      const url = "https://api.worldbank.org/v2/country/" + codes + "/indicator/" +
        ind.code + "?format=json&mrnev=1&per_page=1000";
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      const json = JSON.parse(res.getContentText());
      const rows = (json && json[1]) || [];
      rows.forEach(function (r) {
        if (r && r.countryiso3code && r.value != null && byIso[r.countryiso3code]) {
          byIso[r.countryiso3code].vals[ind.label] = { value: r.value, year: r.date };
        }
      });
    });

    const lines = Object.keys(byIso).map(function (iso) {
      const c = byIso[iso];
      const parts = Object.keys(c.vals).map(function (lbl) {
        return lbl + ": " + fmtNum_(c.vals[lbl].value) + " (" + c.vals[lbl].year + ")";
      });
      if (!parts.length) return null;
      return "- " + c.name + " [World Bank]: " + parts.join("; ") +
        ". Source: https://data.worldbank.org/country/" + iso;
    }).filter(function (x) { return x; });

    return lines.length ? ("World Bank country data:\n" + lines.join("\n")) : "";
  } catch (e) {
    return "";
  }
}

// name(lowercased) -> ISO3, cached 6h. Skips aggregates (regions, income groups).
function wbNameToIso_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("wb_iso_map");
  if (cached) return JSON.parse(cached);

  const res = UrlFetchApp.fetch("https://api.worldbank.org/v2/country?format=json&per_page=400",
    { muteHttpExceptions: true });
  const json = JSON.parse(res.getContentText());
  const rows = (json && json[1]) || [];
  const map = {};
  rows.forEach(function (r) {
    if (r && r.id && r.name && r.region && r.region.value !== "Aggregates") {
      map[r.name.toLowerCase()] = r.id;
    }
  });
  try { cache.put("wb_iso_map", JSON.stringify(map), 21600); } catch (e) {}
  return map;
}

// Best-effort country-name match (World Bank uses names like "Venezuela, RB").
function wbMatchIso_(map, name) {
  const n = String(name || "").toLowerCase().trim();
  if (!n) return "";
  if (map[n]) return map[n];
  const keys = Object.keys(map);
  let hit = keys.find(function (k) { return k.indexOf(n) === 0 || n.indexOf(k) === 0; });
  if (!hit) hit = keys.find(function (k) { return k.indexOf(n) !== -1 || n.indexOf(k) !== -1; });
  return hit ? map[hit] : "";
}

// ── USDA FoodData Central (Food) ─────────────────────────────────────────────
function usdaPack_(items) {
  try {
    const key = PropertiesService.getScriptProperties().getProperty("USDA_API_KEY");
    if (!key) return ""; // not configured -> web_search fallback
    const lines = [];
    items.forEach(function (it) {
      const url = "https://api.nal.usda.gov/fdc/v1/foods/search?api_key=" + encodeURIComponent(key) +
        "&pageSize=1&query=" + encodeURIComponent(it.name);
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      const json = JSON.parse(res.getContentText());
      const food = json && json.foods && json.foods[0];
      if (!food) return;
      const nutr = {};
      (food.foodNutrients || []).forEach(function (fn) {
        const nm = (fn.nutrientName || "").toLowerCase();
        if (nm.indexOf("energy") !== -1 && nutr.calories == null) nutr.calories = fn.value + " " + (fn.unitName || "");
        else if (nm.indexOf("protein") !== -1) nutr.protein = fn.value + "g";
        else if (nm.indexOf("total lipid") !== -1) nutr.fat = fn.value + "g";
        else if (nm.indexOf("carbohydrate") !== -1) nutr.carbs = fn.value + "g";
      });
      const parts = Object.keys(nutr).map(function (k) { return k + " " + nutr[k]; });
      if (parts.length) lines.push("- " + it.name + " [USDA per 100g]: " + parts.join(", ") + ". Source: https://fdc.nal.usda.gov");
    });
    return lines.length ? ("USDA FoodData Central nutrition:\n" + lines.join("\n")) : "";
  } catch (e) {
    return "";
  }
}

// ── shared ───────────────────────────────────────────────────────────────────
function fmtNum_(v) {
  const num = Number(v);
  if (isNaN(num)) return String(v);
  if (Math.abs(num) >= 1000) return Math.round(num).toLocaleString("en-US");
  return (Math.round(num * 100) / 100) + "";
}
