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

// --- Catégories produits + Immobilier ---
// Stratégie : requêtes naturelles ciblant les enseignes par nom
// Les requêtes site: bloquent sur la plupart des sites marocains
// Stratégie finale : chercher les promos des enseignes cibles
// sur les agrégateurs ouverts qui les référencent
const CATEGORIES = [
  {
    name: "Électronique & Tech",
    queries: [
      "site:promomaroc.com electroplanet promotion prix MAD",
      "site:promomaroc.com micromagma biougnach promotion prix MAD",
      "site:discounts.ma electroplanet smartphone TV prix dh",
      "site:soldemaroc.com electroplanet promotion prix MAD",
    ],
  },
  {
    name: "Maison & Déco",
    queries: [
      "site:promomaroc.com marjanemall kitea maison déco promotion prix MAD",
      "site:discounts.ma marjane maison electroménager prix dh",
      "site:soldemaroc.com marjane maison promotion prix MAD",
    ],
  },
  {
    name: "Beauté & Santé",
    queries: [
      "site:promomaroc.com beauté santé cosmétique promotion prix MAD",
      "site:discounts.ma beauté santé pharmacie promotion prix dh",
    ],
  },
  {
    name: "Sport & Loisirs",
    queries: [
      "site:promomaroc.com decathlon sport fitness promotion prix MAD",
      "site:discounts.ma sport loisirs promotion prix dh Maroc",
    ],
  },
  {
    name: "Immobilier",
    queries: [
      "site:sarouty.ma appartement louer Casablanca prix MAD",
      "site:sarouty.ma appartement louer Rabat Marrakech prix MAD",
      "site:avito.ma location appartement Maroc prix MAD",
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

// --- Récupère une image via Google Custom Search ---
async function fetchProductImage(query) {
  try {
    const q = encodeURIComponent(query + " product");
    const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=96e7105d287094ab7&q=${q}&searchType=image&num=1&safe=active`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.items && data.items[0]) {
      return data.items[0].link;
    }
  } catch (e) {
    // silently fail
  }
  return null;
}

// --- Prompt produit style Dealabs ---
function buildProductPrompt(query) {
  return `Tu es un chasseur de bons plans pour le marché marocain, comme Dealabs en France.

Fais une recherche web approfondie sur : "${query}"

Ta mission : trouver des VRAIS produits en promotion actuellement au Maroc avec leur prix en dirhams.

Stratégie de recherche :
1. Cherche directement sur les sites marchands marocains (electroplanet.ma, marjanemall.ma, micromagma.ma, biougnach.ma)
2. Cherche aussi sur les agrégateurs (promomaroc.com, soldemaroc.com, hmizate.ma)
3. Cherche sur Google Shopping Maroc
4. Si tu trouves un prix en euros sur un site international, convertis (1€ ≈ 11 MAD)

Pour chaque produit trouvé avec un prix en dirhams :
- Titre précis du produit (marque + modèle)
- Marque
- Nom du site vendeur
- Prix actuel en MAD (nombre entier)
- Ancien prix en MAD si visible (nombre entier ou null)
- URL de la page produit
- URL de l'image du produit (cherche sur le site ou Google Images)
- Description courte 1 phrase

IMPORTANT : Si tu ne trouves pas de prix exact en MAD, estime le prix en MAD d'après les prix EUR/USD et note-le quand même. Ne retourne JAMAIS un tableau vide si tu as trouvé des produits liés à la requête.

Réponds UNIQUEMENT avec un JSON valide, sans texte avant ou après :
[
  {
    "title": "Samsung Galaxy A35 5G 128Go Bleu",
    "brand": "Samsung",
    "enseigne": "Electroplanet",
    "price": 3799,
    "old_price": 4499,
    "url": "https://www.electroplanet.ma/samsung-galaxy-a35.html",
    "image_url": "https://www.electroplanet.ma/media/catalog/product/samsung_a35.jpg",
    "description": "Smartphone 5G écran 6.6 pouces 50MP"
  }
]

Maximum 5 deals pertinents.`;
}

// --- Prompt immobilier ---
function buildRealEstatePrompt(query) {
  return `Tu es un expert immobilier marocain. Cherche des annonces de location sur sarouty.ma, mubawab.ma, avito.ma et autres sites immobiliers marocains.

Fais une recherche web sur : "${query}"

Pour chaque annonce de location trouvée, extrais toutes les infos disponibles :
- Titre descriptif (type de bien, quartier, ville)
- Ville et quartier précis
- Surface en m² (si mentionnée)
- Loyer mensuel en MAD
- Nombre de pièces/chambres
- URL directe vers l'annonce
- URL de la photo principale
- Description courte : équipements, état, étage, meublé ou non
- Adresse ou rue si disponible

IMPORTANT : Ne retourne JAMAIS un tableau vide. S'il existe des annonces sur ces sites, liste-les.

Réponds UNIQUEMENT avec un JSON valide sans texte avant ou après :
[
  {
    "title": "Appartement S+2 meublé - Maarif, Casablanca",
    "brand": null,
    "enseigne": "Sarouty",
    "price": 5500,
    "old_price": null,
    "url": "https://www.sarouty.ma/annonce/...",
    "image_url": "https://img.sarouty.ma/...",
    "description": "Appartement meublé 80m², 2 chambres, 2ème étage, parking",
    "surface": 80,
    "city": "Casablanca",
    "quartier": "Maarif",
    "address": "Rue Abou Inane, Maarif",
    "rooms": 2,
    "is_real_estate": true
  }
]

Maximum 5 annonces pertinentes.`;
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

      console.log(`   📝 Réponse IA (${text.length} chars): ${text.slice(0, 150)}...`);

      // Extraction JSON robuste - essaie plusieurs patterns
      let items = [];
      const patterns = [
        /\[\s*\{[\s\S]*?\}\s*\]/,
        /\[[\s\S]*\]/,
      ];
      for (const pat of patterns) {
        const m = text.match(pat);
        if (m) {
          try {
            items = JSON.parse(m[0]);
            if (Array.isArray(items) && items.length > 0) break;
          } catch(e) {
            // try next pattern
          }
        }
      }

      if (!items.length) {
        console.log(`   ⚠️ Aucun JSON valide trouvé dans la réponse`);
        return [];
      }

      const rawDeals = items
        .filter((d) => d.title && (d.price || d.price === 0))
        .map((d) => {
          const price = parseFloat(String(d.price).replace(/[^0-9.]/g, '')) || 0;
          const oldPrice = d.old_price ? parseFloat(String(d.old_price).replace(/[^0-9.]/g, '')) || null : null;
          return {
            ...d,
            price,
            old_price: oldPrice,
            category,
            score: isRealEstate
              ? computeRealEstateScore({ price, surface: d.surface, city: d.city })
              : computeProductScore({ price, oldPrice, brand: d.brand, enseigne: d.enseigne, category }),
            scraped_at: new Date().toISOString(),
          };
        })
        .filter(d => d.price > 0);

      // Récupère les images manquantes via Google Custom Search
      for (const deal of rawDeals) {
        if (!deal.image_url) {
          const imgQuery = deal.brand
            ? `${deal.brand} ${deal.title}`
            : `${deal.title} ${deal.enseigne || ''} Maroc`;
          deal.image_url = await fetchProductImage(imgQuery);
          if (deal.image_url) {
            console.log(`   🖼️  Image trouvée pour : ${deal.title}`);
          }
          await sleep(500); // évite le rate limit Google
        }
      }

      return rawDeals;

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
