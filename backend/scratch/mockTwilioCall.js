// scratch/mockTwilioCall.js
// ============================================================
// Mock script to test Twilio WebSocket stream locally
// ============================================================

const ws = require("ws");

// 1. Ensure the server is running on localhost:3000
const wsUrl = "ws://localhost:3000/twilio/stream";

console.log(`Connecting mock Twilio client to: ${wsUrl}`);
const client = new ws(wsUrl);

client.on("open", () => {
  console.log("✅ Mock client connected. Sending 'start' event...");
  
  client.send(JSON.stringify({
    event: "start",
    start: {
      streamSid: "mock-stream-sid-12345",
      callSid: "mock-call-sid-54321"
    }
  }));

  // Send a few mock silent G.711 u-law packets (0xFF is silence)
  let count = 0;
  const interval = setInterval(() => {
    if (count > 20) {
      clearInterval(interval);
      console.log("Mock audio packets finished. Waiting for Gemini responses...");
      return;
    }
    
    // 160 bytes of G.711 u-law represents 20ms of audio at 8kHz
    const silentPayload = Buffer.alloc(160, 0xFF).toString("base64");
    
    client.send(JSON.stringify({
      event: "media",
      media: {
        track: "inbound",
        payload: silentPayload
      }
    }));
    count++;
  }, 20);

  // Auto-close after 12 seconds to let the greeting play
  setTimeout(() => {
    console.log("Closing connection...");
    client.close();
    process.exit(0);
  }, 12000);
});

client.on("message", (rawMsg) => {
  try {
    const msg = JSON.parse(rawMsg.toString());
    console.log(`📥 Received from Server: event="${msg.event}"`, msg.media ? `payload length=${msg.media.payload.length}` : "");
  } catch (e) {
    console.log("📥 Received raw message:", rawMsg.toString().slice(0, 100));
  }
});

client.on("error", (err) => {
  console.error("❌ Mock client error:", err.message);
});

client.on("close", () => {
  console.log("🔌 Connection closed.");
});
