// ============================================================
// PROMOS MAROC — Scraper Intelligent (Claude API + Web Search)
// Tourne 2x/jour via GitHub Actions
// ============================================================

const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");

// --- Config (variables d'environnement GitHub Actions) ---
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --- Catégories à tracker ---
const CATEGORIES = [
  {
    name: "Électronique & Tech",
    queries: [
      "promotions smartphones électronique Maroc aujourd'hui -jumia -temu",
      "soldes TV ordinateur portable Maroc site:.ma",
      "deals electroplanet marjane electro Maroc semaine",
    ],
  },
  {
    name: "Maison & Déco",
    queries: [
      "promotions meubles décoration maison Maroc aujourd'hui -jumia",
      "soldes electroménager cuisine Maroc site:.ma",
      "deals ikea kitea marjane maison Maroc",
    ],
  },
  {
    name: "Beauté & Santé",
    queries: [
      "promotions cosmétiques beauté santé Maroc aujourd'hui -jumia -temu",
      "soldes parfum soin corps pharmacie Maroc site:.ma",
      "deals beauté health Maroc cette semaine",
    ],
  },
  {
    name: "Sport & Loisirs",
    queries: [
      "promotions sport fitness loisirs Maroc aujourd'hui -jumia",
      "soldes vêtements sport équipement Maroc site:.ma",
      "deals sport décathlon intersport Maroc semaine",
    ],
  },
];

// --- Score automatique basé sur critères ---
function computeScore({ price, oldPrice, brand, enseigne, category }) {
  let score = 0;

  // 1. % de réduction (4 pts max)
  if (oldPrice && price && oldPrice > price) {
    const pct = ((oldPrice - price) / oldPrice) * 100;
    if (pct >= 50) score += 4;
    else if (pct >= 35) score += 3;
    else if (pct >= 20) score += 2;
    else if (pct >= 10) score += 1;
  }

  // 2. Marque connue (2 pts max)
  const knownBrands = [
    "samsung", "apple", "lg", "sony", "bosch", "tefal", "xiaomi",
    "hp", "dell", "nike", "adidas", "ikea", "philips", "dyson",
    "nespresso", "rowenta", "moulinex", "loreal", "nivea", "decathlon",
  ];
  if (brand && knownBrands.some((b) => brand.toLowerCase().includes(b))) {
    score += 2;
  } else if (brand) {
    score += 1;
  }

  // 3. Prix accessible marché marocain (2 pts max)
  const limits = {
    "Électronique & Tech": { good: 3000, great: 1500 },
    "Maison & Déco": { good: 1000, great: 500 },
    "Beauté & Santé": { good: 300, great: 150 },
    "Sport & Loisirs": { good: 800, great: 400 },
  };
  const lim = limits[category] || { good: 2000, great: 1000 };
  if (price <= lim.great) score += 2;
  else if (price <= lim.good) score += 1;

  // 4. Enseigne fiable (1 pt)
  const trusted = [
    "electroplanet", "marjane", "carrefour", "bim", "aswak",
    "kitea", "decathlon", "intersport", "yves rocher",
  ];
  if (enseigne && trusted.some((e) => enseigne.toLowerCase().includes(e))) {
    score += 1;
  }

  return Math.min(10, Math.max(1, score));
}

// --- Appel Claude avec web search pour une query ---
async function searchDeals(query, category) {
  console.log(`🔍 Recherche : "${query}"`);

  const prompt = `Tu es un expert en deals et promotions pour le marché marocain.

Recherche sur le web les meilleures promotions pour cette requête : "${query}"

Objectif : trouver des vraies promotions actives au Maroc (pas Jumia, pas Temu).

Pour chaque deal trouvé, extrais :
- Le nom exact du produit
- L'enseigne/site vendeur
- La marque du produit
- Le prix actuel en MAD (dirham marocain)
- L'ancien prix en MAD (si disponible)
- L'URL directe vers le produit
- La date d'expiration si mentionnée

Réponds UNIQUEMENT avec un tableau JSON valide (pas de texte avant/après, pas de backticks) :
[
  {
    "title": "nom court du produit",
    "enseigne": "nom du vendeur",
    "brand": "marque",
    "price": 999,
    "old_price": 1499,
    "url": "https://...",
    "expires_at": "2024-12-31" ou null
  }
]

Si tu ne trouves aucun deal, retourne un tableau vide : []
Maximum 5 deals par recherche. Ne mets QUE des deals avec un vrai prix en MAD.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    });

    const textBlocks = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Extraction JSON robuste
    const jsonMatch = textBlocks.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const deals = JSON.parse(jsonMatch[0]);
    return deals
      .filter((d) => d.title && d.price && d.price > 0)
      .map((d) => ({
        ...d,
        category,
        score: computeScore({
          price: d.price,
          oldPrice: d.old_price,
          brand: d.brand,
          enseigne: d.enseigne,
          category,
        }),
        scraped_at: new Date().toISOString(),
      }));
  } catch (err) {
    console.error(`❌ Erreur pour "${query}":`, err.message);
    return [];
  }
}

// --- Vérifie si un deal existe déjà (évite les doublons) ---
async function dealExists(title, enseigne) {
  const { data } = await supabase
    .from("deals")
    .select("id")
    .ilike("title", `%${title.slice(0, 30)}%`)
    .eq("enseigne", enseigne)
    .gte("scraped_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .limit(1);
  return data && data.length > 0;
}

// --- Sauvegarde les deals dans Supabase ---
async function saveDeals(deals) {
  let saved = 0;
  for (const deal of deals) {
    const exists = await dealExists(deal.title, deal.enseigne);
    if (exists) {
      console.log(`⏭️  Doublon ignoré : ${deal.title}`);
      continue;
    }
    const { error } = await supabase.from("deals").insert({
      title: deal.title,
      enseigne: deal.enseigne,
      brand: deal.brand || null,
      price: deal.price,
      old_price: deal.old_price || null,
      category: deal.category,
      url: deal.url || null,
      score: deal.score,
      expires_at: deal.expires_at || null,
      scraped_at: deal.scraped_at,
      discount_pct:
        deal.old_price && deal.price
          ? Math.round(((deal.old_price - deal.price) / deal.old_price) * 100)
          : null,
    });
    if (!error) {
      saved++;
      console.log(`✅ Sauvegardé : ${deal.title} — ${deal.price} MAD (score: ${deal.score}/10)`);
    } else {
      console.error(`❌ Erreur sauvegarde : ${error.message}`);
    }
  }
  return saved;
}

// --- Programme principal ---
async function main() {
  console.log("🚀 Promos Maroc Scraper — Démarrage");
  console.log(`📅 ${new Date().toLocaleString("fr-FR")}`);
  console.log("=".repeat(50));

  let totalDeals = 0;

  for (const category of CATEGORIES) {
    console.log(`\n📦 Catégorie : ${category.name}`);

    for (const query of category.queries) {
      const deals = await searchDeals(query, category.name);
      console.log(`   Trouvés : ${deals.length} deals`);

      if (deals.length > 0) {
        const saved = await saveDeals(deals);
        totalDeals += saved;
      }

      // Pause pour respecter les rate limits
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log("\n" + "=".repeat(50));
  console.log(`🎉 Terminé ! ${totalDeals} nouveaux deals sauvegardés`);

  // Nettoyer les vieux deals (+7 jours)
  const { error } = await supabase
    .from("deals")
    .delete()
    .lt(
      "scraped_at",
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    );
  if (!error) console.log("🧹 Vieux deals nettoyés (>7 jours)");
}

main().catch(console.error);
