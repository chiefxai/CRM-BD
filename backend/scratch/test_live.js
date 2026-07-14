require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { GoogleGenAI } = require("@google/genai");

const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  apiVersion: "v1alpha",
});

async function run() {
  console.log("Connecting to Gemini Live API...");
  const session = await genai.live.connect({
    model: "gemini-2.5-flash-native-audio-latest",
    config: {
      systemInstruction: {
        parts: [{ text: "You are a customer assistant. Respond with 1 short Tanglish sentence." }]
      },
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Puck" }
        }
      },
      inputAudioTranscription:  {},
      outputAudioTranscription: {}
    },
    callbacks: {
      onmessage: () => {},
      onerror: () => {},
      onclose: () => {}
    }
  });

  console.log("✅ Session connected!");

  // Listen to raw WebSocket packets
  session.conn.ws.on("message", (data) => {
    try {
      const payload = JSON.parse(data.toString());
      console.log("\n📥 [RAW RECEIVE] Keys:", Object.keys(payload));
      
      // Dump full structure of metadata if present
      if (payload.usageMetadata) {
        console.log("🔥 usageMetadata at root level:", JSON.stringify(payload.usageMetadata));
      }
      if (payload.usage_metadata) {
        console.log("🔥 usage_metadata at root level (snake_case):", JSON.stringify(payload.usage_metadata));
      }
      if (payload.serverContent) {
        console.log(" - serverContent keys:", Object.keys(payload.serverContent));
        if (payload.serverContent.usageMetadata) {
          console.log("🔥 usageMetadata inside serverContent:", JSON.stringify(payload.serverContent.usageMetadata));
        }
        if (payload.serverContent.usage_metadata) {
          console.log("🔥 usage_metadata inside serverContent (snake_case):", JSON.stringify(payload.serverContent.usage_metadata));
        }
        if (payload.serverContent.modelTurn) {
          console.log(" - modelTurn parts:", payload.serverContent.modelTurn.parts.map(p => p.inlineData ? `[audio content: ${p.inlineData.data.length} bytes]` : JSON.stringify(p)));
        }
        if (payload.serverContent.outputTranscription) {
          console.log(" - outputTranscription text:", payload.serverContent.outputTranscription.text);
        }
      }
    } catch (e) {
      console.log(" - Non-JSON frame received:", data.toString().slice(0, 100));
    }
  });

  // Wait 3 seconds, then send first user prompt
  setTimeout(() => {
    console.log("\n📤 Sending: 'Hi, I want to order some rice'...");
    session.conn.ws.send(JSON.stringify({
      client_content: {
        turns: [
          {
            role: "user",
            parts: [{ text: "Hi, I want to order some rice" }]
          }
        ],
        turn_complete: true
      }
    }));
  }, 3000);

  // Wait 12 seconds, then send second user prompt to make it a continuous 20s conversation
  setTimeout(() => {
    console.log("\n📤 Sending: 'How much is it?'...");
    session.conn.ws.send(JSON.stringify({
      client_content: {
        turns: [
          {
            role: "user",
            parts: [{ text: "How much is it?" }]
          }
        ],
        turn_complete: true
      }
    }));
  }, 12000);

  // Run for 22 seconds total, then close
  setTimeout(async () => {
    console.log("\nClosing session...");
    await session.close();
    console.log("Done.");
    process.exit(0);
  }, 22000);
}

run().catch(console.error);
