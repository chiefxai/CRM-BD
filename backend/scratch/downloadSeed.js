const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

async function main() {
  const sourceBase = "https://w9h781m5-8000.inc1.devtunnels.ms";

  try {
    console.log("🔍 Fetching collection ID dynamically from source...");
    const collectionsRes = await fetch(`${sourceBase}/api/v2/tenants/default_tenant/databases/default_database/collections`);
    const collections = await collectionsRes.json();
    const targetColl = collections.find(c => c.name === "policy-documents");
    if (!targetColl) {
      throw new Error("policy-documents collection not found on source DB!");
    }
    const collectionId = targetColl.id;
    console.log(`✅ Found Collection ID: ${collectionId}`);

    console.log("📥 Downloading policy documents from source Chroma (WITH embeddings)...");
    const getUrl = `${sourceBase}/api/v2/tenants/default_tenant/databases/default_database/collections/${collectionId}/get`;
    const res = await fetch(getUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        include: ["documents", "metadatas", "embeddings"]
      })
    });

    if (!res.ok) {
      throw new Error(`Source fetch failed: ${res.statusText}`);
    }

    const data = await res.json();
    console.log(`✅ Fetched ${data.ids.length} chunks.`);

    // Write to root of workspace
    const seedPath = path.resolve("./policy_documents_seed.json");
    fs.writeFileSync(seedPath, JSON.stringify(data, null, 2));
    console.log(`🎉 Seed data saved locally to: ${seedPath}`);
  } catch (err) {
    console.error("❌ Failed to download seed data:", err.message);
  }
}

main();
