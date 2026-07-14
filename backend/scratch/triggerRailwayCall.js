// scratch/triggerRailwayCall.js
const railwayUrl = "https://chiefvoice-web-production.up.railway.app/api/twilio/call";
const targetPhone = "+918939479296";

console.log(`Sending trigger request to: ${railwayUrl}`);
console.log(`Target Phone Number: ${targetPhone}`);

fetch(railwayUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded"
  },
  body: new URLSearchParams({ phoneNumber: targetPhone })
})
.then(async (res) => {
  const data = await res.json();
  console.log("Status:", res.status);
  console.log("Response:", data);
})
.catch((err) => {
  console.error("Error triggering call:", err);
});
