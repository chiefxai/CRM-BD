// scratch/testGreeting.js
require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");

const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  apiVersion: "v1alpha",
});

async function test() {
  try {
    console.log("Connecting...");
    const session = await genai.live.connect({
      model: "gemini-2.5-flash-native-audio-latest",
      config: {
        responseModalities: ["AUDIO"]
      },
      callbacks: {
        onmessage: (data) => {
          console.log("📥 Received from Gemini:", JSON.stringify(data).slice(0, 400));
        },
        onerror: (err) => {
          console.error("❌ Gemini error:", err);
        }
      }
    });

    console.log("Connected. Waiting 2 seconds for setupComplete...");

    // Wait 2 seconds for setup to complete
    setTimeout(() => {
      console.log("Sending clientContent turn (camelCase) via raw WebSocket...");
      session.conn.ws.send(JSON.stringify({
        clientContent: {
          turns: [
            {
              role: "user",
              parts: [{ text: "Good morning sir! May I speak to Britto?" }]
            }
          ],
          turnComplete: true
        }
      }));
    }, 2000);

    // Close after 8 seconds
    setTimeout(() => {
      console.log("Closing...");
      session.close();
    }, 8000);

  } catch (e) {
    console.error("Error:", e);
  }
}

test();
