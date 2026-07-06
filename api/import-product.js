// Compat'PC V4.5 — Import produit par URL (fonction serverless Vercel)
// Remplace l'ancien serveur Python local : même logique, même format de réponse.

const MAX_BYTES = 2500000;

function validatePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("URL invalide."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL invalide.");
  const host = (url.hostname || "").toLowerCase();
  if (!host) throw new Error("URL invalide.");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Adresse locale refusée.");
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224) {
      throw new Error("Adresse réseau privée refusée.");
    }
  }
  if (host.includes(":")) throw new Error("Adresse IPv6 littérale refusée.");
  return url;
}

function decodeAttrEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ");
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) {
    attrs[m[1].toLowerCase()] = decodeAttrEntities(m[3] ?? m[4] ?? m[5] ?? "");
  }
  return attrs;
}

function parseHtml(html) {
  const meta = {};
  let m;
  const metaRe = /<meta\b[^>]*>/gi;
  while ((m = metaRe.exec(html))) {
    const attrs = parseAttrs(m[0]);
    const key = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    const val = (attrs.content || "").trim();
    if (key && val && !(key in meta)) meta[key] = val;
  }
  const jsonld = [];
  const ldRe = /<script\b[^>]*type\s*=\s*["'][^"']*ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = ldRe.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try { jsonld.push(JSON.parse(raw)); } catch { /* JSON-LD malformé : ignoré */ }
  }
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = t ? decodeAttrEntities(t[1]).replace(/\s+/g, " ").trim() : "";
  return { meta, jsonld, title };
}

function* flattenJsonld(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* flattenJsonld(item);
  } else if (node && typeof node === "object") {
    if (node["@graph"]) yield* flattenJsonld(node["@graph"]);
    yield node;
  }
}

function isProduct(node) {
  const typ = node["@type"] || "";
  const types = Array.isArray(typ) ? typ : [typ];
  return types.some(x => String(x).toLowerCase() === "product");
}

function firstValue(value) {
  if (Array.isArray(value)) return value.length ? firstValue(value[0]) : "";
  if (value && typeof value === "object") return value.url || value.contentUrl || value.name || "";
  return value || "";
}

function cleanPrice(value) {
  if (typeof value === "number") return value;
  if (!value) return 0;
  const match = String(value).match(/\d[\d\s.,\u00a0]*/);
  if (!match) return 0;
  let raw = match[0].replace(/\u00a0/g, "").replace(/\s/g, "");
  if (raw.includes(",") && raw.includes(".")) raw = raw.replace(/\./g, "").replace(",", ".");
  else raw = raw.replace(",", ".");
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function textBlob(product, meta, title) {
  const fields = [
    title, product.name || "", product.description || "",
    meta["og:description"] || "", meta.description || ""
  ];
  const brand = product.brand;
  fields.push(brand && typeof brand === "object" ? String(brand.name || "") : String(brand || ""));
  return fields.filter(Boolean).join(" ");
}

function inferCategory(text, forced = "auto") {
  if (forced && forced !== "auto") return forced;
  const rules = [
    ["gpu", /\b(RTX|GeForce|Radeon|RX\s?\d{4})\b/i],
    ["cooler", /\b(AIO|watercool|liquid cooler|Kraken|Galahad|H1[05]0i|Frozen|Ryujin|Mystique)\b/i],
    ["case", /\b(bo[iî]tier|computer case|pc case|chassis|mid tower|full tower|O11|NV5|Y60|Y70|AIR 903)\b/i],
    ["motherboard", /\b(motherboard|carte m[eè]re|B650|B850|X670|X870|Z790|B760)\b/i],
    ["ram", /\b(DDR4|DDR5|RAM|memory kit|m[eé]moire)\b/i],
    ["ssd", /\b(SSD|NVMe|M\.2|990 Pro|SN850)\b/i],
    ["psu", /\b(power supply|alimentation|PSU|[6789]\d{2}\s*W)\b/i],
    ["fans", /\b(case fan|ventilateur|UNI FAN|Light Wings|QX120|D30-120)\b/i],
    ["cpu", /\b(Ryzen|Core i[3579]|Core Ultra)\b/i],
  ];
  for (const [cat, pattern] of rules) if (pattern.test(text)) return cat;
  return "case";
}

function inferSpecs(text, cat) {
  const num = (pattern) => {
    const m = text.match(pattern);
    return m ? parseInt(m[1], 10) : null;
  };
  const color = /\b(white|blanc|snow)\b/i.test(text) ? "white"
    : /\b(black|noir)\b/i.test(text) ? "black" : "neutral";
  const specs = { color };
  if (cat === "gpu") {
    specs.vram = num(/\b(8|10|12|16|20|24|32)\s*(?:GB|Go)\b/i);
    specs.length = num(/(?:length|longueur)[^\d]{0,25}(\d{3})\s*mm/i);
    specs.power = num(/(?:TDP|TBP|power|consommation)[^\d]{0,20}(\d{2,3})\s*W/i);
    specs.gpuBrand = /RTX|GeForce/i.test(text) ? "nvidia" : "amd";
  } else if (cat === "cooler") {
    specs.rad = num(/\b(120|240|280|360|420)\s*mm\b/i);
    specs.gif = /\b(GIF|LCD|display|écran)\b/i.test(text);
  } else if (cat === "case") {
    specs.maxGpu = num(/(?:GPU|graphics card)[^\d]{0,30}(?:max(?:imum)?|up to)?[^\d]{0,10}(\d{3})\s*mm/i);
    specs.style = /aquarium|panoramic|dual chamber|O11|NV5|Y60|Y70|H6|H9|C8/i.test(text) ? "aquarium" : "classic";
    const rads = new Set();
    const radRe = /\b(120|240|280|360|420)\s*mm\b/gi;
    let r;
    while ((r = radRe.exec(text))) rads.add(parseInt(r[1], 10));
    specs.radList = [...rads].sort((a, b) => a - b);
  } else if (cat === "psu") {
    specs.watts = num(/\b(\d{3,4})\s*W\b/i);
  } else if (cat === "ssd") {
    const m = text.match(/\b(1|2|4|8)\s*(?:TB|To)\b/i);
    specs.capacity = m ? parseInt(m[1], 10) : null;
  }
  for (const k of Object.keys(specs)) {
    const v = specs[k];
    if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) delete specs[k];
  }
  return specs;
}

function extractProduct(html, finalUrl, forcedCategory) {
  const { meta, jsonld, title } = parseHtml(html);
  const candidates = [];
  for (const root of jsonld) {
    for (const node of flattenJsonld(root)) {
      if (node && typeof node === "object" && isProduct(node)) candidates.push(node);
    }
  }
  const product = candidates[0] || {};
  let offers = product.offers || {};
  if (Array.isArray(offers)) offers = offers[0] || {};
  const aggregate = product.aggregateOffer || {};
  const name = product.name || meta["og:title"] || meta["twitter:title"] || title;
  const description = product.description || meta["og:description"] || meta.description || "";
  const image = firstValue(product.image) || meta["og:image"] || meta["twitter:image"] || "";
  const price = cleanPrice(
    offers.price || offers.lowPrice || aggregate.lowPrice ||
    meta["product:price:amount"] || meta["og:price:amount"]
  );
  const currency = offers.priceCurrency || aggregate.priceCurrency || meta["product:price:currency"] || "EUR";
  let brand = product.brand || "";
  if (brand && typeof brand === "object") brand = brand.name || "";
  const blob = textBlob(product, meta, title);
  const cat = inferCategory(blob, forcedCategory);
  const result = {
    cat,
    name: String(name || "Produit importé").trim().slice(0, 200),
    description: String(description).replace(/\s+/g, " ").trim().slice(0, 1600),
    image: String(image || ""),
    price,
    currency: String(currency || "EUR"),
    brand: String(brand || ""),
    url: finalUrl,
    ...inferSpecs(blob, cat),
  };
  const warnings = [];
  if (!candidates.length) warnings.push("Aucune fiche Product JSON-LD trouvée : données issues des métadonnées de la page.");
  if (!result.price) warnings.push("Prix non détecté ou masqué par le marchand.");
  if (!result.image) warnings.push("Image non détectée.");
  return { product: result, warnings };
}

async function fetchProduct(rawUrl, forced) {
  validatePublicUrl(rawUrl);
  let response;
  try {
    response = await fetch(rawUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(14000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.7",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error("La page met trop de temps à répondre. Utilise le mode de secours (copier-coller du texte).");
    }
    throw new Error("Impossible de joindre ce site. Utilise le mode de secours (copier-coller du texte).");
  }
  validatePublicUrl(response.url || rawUrl);
  if (response.status === 403 || response.status === 429 || response.status === 503) {
    throw new Error("Ce marchand bloque la lecture automatique (protection anti-robot). Utilise le mode de secours : ouvre la page, copie le texte de la fiche produit et colle-le dans le champ prévu.");
  }
  if (!response.ok) throw new Error("La page a répondu avec une erreur (" + response.status + ").");
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("html")) throw new Error("Le lien ne pointe pas vers une page HTML.");
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) throw new Error("Page trop volumineuse.");
  let charset = "utf-8";
  const cm = contentType.match(/charset=([\w-]+)/i);
  if (cm) charset = cm[1];
  let html;
  try { html = new TextDecoder(charset, { fatal: false }).decode(buffer); }
  catch { html = new TextDecoder("utf-8", { fatal: false }).decode(buffer); }
  return extractProduct(html, response.url || rawUrl, forced);
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") {
    res.status(404).json({ ok: false, error: "Introuvable." });
    return;
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const url = String(body.url || "");
    const category = String(body.category || "auto");
    if (!url) throw new Error("URL manquante.");
    const { product, warnings } = await fetchProduct(url, category);
    res.status(200).json({ ok: true, product, warnings });
  } catch (exc) {
    res.status(400).json({ ok: false, error: exc.message || "Import impossible." });
  }
};
