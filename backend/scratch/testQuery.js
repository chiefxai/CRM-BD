const fetch = require("node-fetch");

async function main() {
  try {
    const chromaUrl = "https://chroma-corechroma-production-1118.up.railway.app";
    
    // Get collections list
    const listRes = await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`);
    const collections = await listRes.json();
    const targetColl = collections.find(c => c.name === "policy-documents");
    if (!targetColl) {
      console.log("❌ Collection not found on new Chroma DB!");
      return;
    }
    const collectionId = targetColl.id;

    const url = `${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections/${collectionId}/get`;
    console.log("🔍 Running RAG query for keyword: 'price'...");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        where_document: { "$contains": "price" },
        limit: 1,
        include: ["documents"]
      })
    });
    
    const data = await res.json();
    console.log("Result for 'price':", JSON.stringify(data, null, 2));

    console.log("\n🔍 Running RAG query for keyword: 'premium'...");
    const res2 = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        where_document: { "$contains": "premium" },
        limit: 1,
        include: ["documents"]
      })
    });
    
    const data2 = await res2.json();
    console.log("Result for 'premium':", JSON.stringify(data2, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
  }
}

main();
