const fetch = require("node-fetch"); // or use global fetch if node supports it

async function main() {
  try {
    // Standard Chroma DB v2 collections endpoint
    const url = "https://chroma-corechroma-production-1118.up.railway.app/api/v2/tenants/default_tenant/databases/default_database/collections";
    console.log("Fetching collections from:", url);
    const res = await fetch(url);
    const data = await res.json();
    console.log("Collections:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
  }
}

main();
