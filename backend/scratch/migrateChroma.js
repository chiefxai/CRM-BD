const fetch = require("node-fetch");

async function main() {
  const sourceBase = "https://w9h781m5-8000.inc1.devtunnels.ms";
  const targetBase = "https://chroma-corechroma-production-1118.up.railway.app";
  const collectionName = "policy-documents";
  const collectionId = "92ec6ff0-999f-4892-874e-5b8679ebe4c8";

  try {
    console.log(`📥 Step 1: Fetching all documents from old Chroma DB: ${sourceBase}`);
    const getUrl = `${sourceBase}/api/v2/tenants/default_tenant/databases/default_database/collections/${collectionId}/get`;
    const getRes = await fetch(getUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        include: ["documents", "metadatas", "embeddings"]
      })
    });
    
    if (!getRes.ok) {
      throw new Error(`Failed to fetch documents from old DB: ${getRes.statusText}`);
    }

    const data = await getRes.json();
    if (!data.ids || data.ids.length === 0) {
      console.log("⚠️ No documents found in the source database collection.");
      return;
    }
    console.log(`✅ Loaded ${data.ids.length} documents/chunks from source.`);

    console.log(`📤 Step 2: Creating collection "${collectionName}" on new Chroma DB: ${targetBase}`);
    const createUrl = `${targetBase}/api/v2/tenants/default_tenant/databases/default_database/collections`;
    const createRes = await fetch(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: collectionName,
        metadata: { description: "Health Insurance Policy Documents" },
        get_or_create: true
      })
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create collection on target DB: ${createRes.statusText}`);
    }

    const targetCollection = await createRes.json();
    const newCollectionId = targetCollection.id;
    console.log(`✅ Collection created/verified on target. Target Collection ID: ${newCollectionId}`);

    console.log(`📤 Step 3: Uploading ${data.ids.length} records into the new collection...`);
    const addUrl = `${targetBase}/api/v2/tenants/default_tenant/databases/default_database/collections/${newCollectionId}/add`;
    
    // Construct payload
    const addPayload = {
      ids: data.ids,
      embeddings: data.embeddings,
      metadatas: data.metadatas,
      documents: data.documents
    };

    const addRes = await fetch(addUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(addPayload)
    });

    if (!addRes.ok) {
      const errMsg = await addRes.text();
      throw new Error(`Failed to add records to new DB: ${errMsg}`);
    }

    console.log("🎉 SUCCESS! All policy documents and embeddings have been migrated to the new Railway database!");
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
  }
}

main();
