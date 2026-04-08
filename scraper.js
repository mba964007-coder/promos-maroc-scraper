// ============================================================
// PROMOS MAROC — Scraper Intelligent v3
// Style Dealabs : produit en avant, image réelle, prix barré
// Sites ciblés + Immobilier Sarouty
// ============================================================

const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --- Sites cibles précis ---
const SITES = {
  electroplanet: "electroplanet.ma",
  micromagma: "micromagma.ma",
  marjane: "marjanemall.ma",
  biougnach: "biougnach.ma",
  sarouty: "sarouty.ma",
};

// --- Catégories produits + Immobilier ---
const CATEGORIES = [
  {
    name: "Électronique & Tech",
    queries: [
      `site:${SITES.electroplanet} promotion smartphone TV ordinateur prix réduit 2026`,
      `site:${SITES.micromagma} promotion deals prix réduit informatique 2026`,
      `site:${SITES.biougnach} promotion électroménager prix réduit 2026`,
    ],
  },
  {
    name: "Maison & Déco",
    queries: [
      `site:${SITES.marjane} promotion maison déco électroménager prix réduit 2026`,
      `site:${SITES.biougnach} promotion gros électroménager cuisine prix réduit 2026`,
      `site:${SITES.electroplanet} promotion électroménager cuisine prix réduit 2026`,
    ],
  },
  {
    name: "Beauté & Santé",
    queries: [
      `site:${SITES.marjane} promotion beauté santé cosmétique prix réduit 2026`,
      `beauté santé cosmétique promotion Maroc site:.ma -jumia -temu 2026`,
    ],
  },
  {
    name: "Sport & Loisirs",
    queries: [
      `site:${SITES.marjane} promotion sport loisirs fitness prix réduit 2026`,
      `decathlon maroc promotion sport équipement prix réduit 2026`,
    ],
  },
  {
    name: "Immobilier",
    queries: [
      `site:${SITES.sarouty} appartement louer Casablanca prix pas cher 2026`,
      `site:${SITES.sarouty} appartement louer Rabat Marrakech prix pas cher 2026`,
      `site:${SITES.sarouty} studio louer Maroc bon plan pas cher 2026`,
    ],
  },
];

// --- Score produits ---
function computeProductScore({ price, oldPrice, brand, enseigne, category }) {
  let score = 0;

  if (oldPrice && price && oldPrice > price) {
    const pct = ((oldPrice - price) / oldPrice) * 100;
    if (pct >= 50) score += 4;
    else if (pct >= 35) score += 3;
    else if (pct >= 20) score += 2;
    else if (pct >= 10) score += 1;
  }

  const knownBrands = [
    "samsung", "apple", "lg", "sony", "bosch", "tefal", "xiaomi",
    "hp", "dell", "nike", "adidas", "ikea", "philips", "dyson",
    "nespresso", "rowenta", "moulinex", "loreal", "nivea", "decathlon",
  ];
  if (brand && knownBrands.some((b) => brand.toLowerCase().includes(b))) score += 2;
  else if (brand) score += 1;

  const limits = {
    "Électronique & Tech": { good: 3000, great: 1500 },
    "Maison & Déco": { good: 1000, great: 500 },
    "Beauté & Santé": { good: 300, great: 150 },
    "Sport & Loisirs": { good: 800, great: 400 },
  };
  const lim = limits[category] || { good: 2000, great: 1000 };
  if (price <= lim.great) score += 2;
  else if (price <= lim.good) score += 1;

  const trusted = ["electroplanet", "marjane", "micromagma", "biougnach", "carrefour", "bim", "decathlon"];
  if (enseigne && trusted.some((e) => enseigne.toLowerCase().includes(e))) score += 1;

  return Math.min(10, Math.max(1, score));
}

// --- Score immobilier (basé sur prix/m² et ville) ---
function computeRealEstateScore({ price, surface, city }) {
  let score = 5;
  if (!price) return score;

  const pricePerM2 = surface ? price / surface : null;
  const cityBenchmarks = {
    casablanca: { good: 6000, great: 4000 },
    rabat: { good: 5000, great: 3500 },
    marrakech: { good: 5000, great: 3000 },
    tanger: { good: 4000, great: 2500 },
    fes: { good: 3000, great: 2000 },
    agadir: { good: 3500, great: 2500 },
  };

  const cityKey = Object.keys(cityBenchmarks).find(c =>
    (city || "").toLowerCase().includes(c)
  );

  if (pricePerM2 && cityKey) {
    const bench = cityBenchmarks[cityKey];
    if (pricePerM2 <= bench.great) score = 9;
    else if (pricePerM2 <= bench.good) score = 7;
    else score = 5;
  } else if (price < 3000) score = 8;
  else if (price < 5000) score = 6;
  else if (price < 8000) score = 5;
  else score = 3;

  return Math.min(10, Math.max(1, score));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Prompt produit style Dealabs ---
function buildProductPrompt(query) {
  return `Tu es un expert deals comme Dealabs, mais pour le marché marocain.

Recherche sur le web : "${query}"

IMPORTANT — Style Dealabs : chaque deal doit avoir :
- Un produit PRÉCIS (pas une catégorie générale)
- L'image RÉELLE du produit (URL directe .jpg/.png/.webp depuis le site marchand)
- Le prix actuel ET l'ancien prix si disponible
- Le lien direct vers la page produit (pas la page d'accueil)

Pour chaque produit en promotion trouvé, extrais :
- Titre court et accrocheur du produit
- Marque
- Enseigne/site vendeur
- Prix actuel en MAD
- Ancien prix en MAD (si barré sur la page)
- URL directe vers la page du produit
- URL de l'image du produit (cherche l'image sur la page produit ou Google Images)
- Brève description 1 phrase max

Réponds UNIQUEMENT avec un JSON valide sans backticks :
[
  {
    "title": "Samsung Galaxy A55 5G 128Go",
    "brand": "Samsung",
    "enseigne": "Electroplanet",
    "price": 3499,
    "old_price": 4299,
    "url": "https://www.electroplanet.ma/...",
    "image_url": "https://www.electroplanet.ma/media/catalog/product/s/a/samsung_a55.jpg",
    "description": "Smartphone 5G avec écran Super AMOLED 6.6 pouces"
  }
]

Maximum 5 deals. Uniquement des produits avec prix en MAD. Tableau vide [] si rien trouvé.`;
}

// --- Prompt immobilier ---
function buildRealEstatePrompt(query) {
  return `Tu es un expert immobilier pour le marché marocain, style Sarouty/Mubawab.

Recherche sur le web : "${query}"

Pour chaque annonce de location trouvée, extrais :
- Titre de l'annonce (ex: "Appartement 2 pièces Maarif Casablanca")
- Ville et quartier précis
- Surface en m²
- Prix de location mensuel en MAD
- Nombre de pièces
- URL directe vers l'annonce
- URL de la photo principale du bien
- Description courte (équipements, état, étage)
- Adresse approximative si disponible

Réponds UNIQUEMENT avec un JSON valide sans backticks :
[
  {
    "title": "Appartement 2 pièces - Maarif, Casablanca",
    "brand": null,
    "enseigne": "Sarouty",
    "price": 4500,
    "old_price": null,
    "url": "https://www.sarouty.ma/...",
    "image_url": "https://...",
    "description": "Appartement meublé 65m², 2 chambres, parking inclus",
    "surface": 65,
    "city": "Casablanca",
    "quartier": "Maarif",
    "address": "Boulevard Zerktouni, Casablanca",
    "rooms": 2,
    "is_real_estate": true
  }
]

Maximum 5 annonces. Uniquement des locations avec prix en MAD. Tableau vide [] si rien trouvé.`;
}

// --- Appel Claude avec retry ---
async function searchDeals(query, category, retries = 3) {
  console.log(`🔍 Recherche : "${query}"`);
  const isRealEstate = category === "Immobilier";
  const prompt = isRealEstate ? buildRealEstatePrompt(query) : buildProductPrompt(query);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const items = JSON.parse(jsonMatch[0]);
      return items
        .filter((d) => d.title && d.price && d.price > 0)
        .map((d) => ({
          ...d,
          category,
          score: isRealEstate
            ? computeRealEstateScore({ price: d.price, surface: d.surface, city: d.city })
            : computeProductScore({ price: d.price, oldPrice: d.old_price, brand: d.brand, enseigne: d.enseigne, category }),
          scraped_at: new Date().toISOString(),
        }));

    } catch (err) {
      if (err.message && err.message.includes("429")) {
        const wait = attempt * 30000;
        console.log(`⏳ Rate limit — attente ${wait / 1000}s (tentative ${attempt}/${retries})...`);
        await sleep(wait);
      } else {
        console.error(`❌ Erreur : ${err.message}`);
        return [];
      }
    }
  }
  return [];
}

// --- Vérif doublon ---
async function dealExists(title, enseigne) {
  const { data } = await supabase
    .from("deals")
    .select("id")
    .ilike("title", `%${title.slice(0, 30)}%`)
    .eq("enseigne", enseigne || "")
    .gte("scraped_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .limit(1);
  return data && data.length > 0;
}

// --- Sauvegarde ---
async function saveDeals(deals) {
  let saved = 0;
  for (const deal of deals) {
    const exists = await dealExists(deal.title, deal.enseigne);
    if (exists) { console.log(`⏭️  Doublon : ${deal.title}`); continue; }

    const { error } = await supabase.from("deals").insert({
      title: deal.title,
      enseigne: deal.enseigne || null,
      brand: deal.brand || null,
      price: deal.price,
      old_price: deal.old_price || null,
      category: deal.category,
      url: deal.url || null,
      image_url: deal.image_url || null,
      score: deal.score,
      expires_at: deal.expires_at || null,
      scraped_at: deal.scraped_at,
      discount_pct: deal.old_price && deal.price
        ? Math.round(((deal.old_price - deal.price) / deal.old_price) * 100)
        : null,
      // Champs immobilier
      surface: deal.surface || null,
      city: deal.city || null,
      quartier: deal.quartier || null,
      address: deal.address || null,
      rooms: deal.rooms || null,
      is_real_estate: deal.is_real_estate || false,
      description: deal.description || null,
    });

    if (!error) {
      saved++;
      const icon = deal.is_real_estate ? "🏠" : "✅";
      console.log(`${icon} ${deal.title} — ${deal.price} MAD (score: ${deal.score}/10)`);
    } else {
      console.error(`❌ Erreur DB : ${error.message}`);
    }
  }
  return saved;
}

// --- Main ---
async function main() {
  console.log("🚀 Promos Maroc Scraper v3 — Style Dealabs + Immobilier");
  console.log(`📅 ${new Date().toLocaleString("fr-FR")}`);
  console.log("=".repeat(60));

  let total = 0;

  for (const category of CATEGORIES) {
    console.log(`\n📦 ${category.name}`);
    for (const query of category.queries) {
      const deals = await searchDeals(query, category.name);
      console.log(`   Trouvés : ${deals.length}`);
      if (deals.length > 0) total += await saveDeals(deals);
      console.log(`⏳ Pause 25s...`);
      await sleep(25000);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`🎉 ${total} nouveaux deals sauvegardés`);

  await supabase.from("deals").delete()
    .lt("scraped_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  console.log("🧹 Vieux deals nettoyés");
}

main().catch(console.error);
