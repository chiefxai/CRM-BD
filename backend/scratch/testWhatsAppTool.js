// scratch/testWhatsAppTool.js
require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");

const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  apiVersion: "v1alpha",
});

async function mockSendWhatsApp(to, body) {
  console.log(`[MOCK WHATSAPP] Sending to ${to}: "${body}"`);
  return true; // Simulate success
}

async function test() {
  try {
    console.log("Connecting to Gemini Live API...");
    const session = await genai.live.connect({
      model: "gemini-2.5-flash-native-audio-latest",
      config: {
        responseModalities: ["AUDIO"],
        tools: [
          {
            functionDeclarations: [
              {
                name: "sendWhatsAppDetails",
                description: "Sends a WhatsApp message with documentation or brochure details to the caller's phone number.",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    detailsType: {
                      type: "STRING",
                      description: "The type of details requested (e.g. 'pricing', 'document', or 'brochure')."
                    }
                  },
                  required: ["detailsType"]
                }
              }
            ]
          }
        ]
      },
      callbacks: {
        onmessage: (data) => {
          // Detect toolCall
          if (data.toolCall?.functionCalls) {
            for (const call of data.toolCall.functionCalls) {
              if (call.name === "sendWhatsAppDetails") {
                console.log("📥 Gemini requested toolCall:", call);
                
                // Simulate execution
                mockSendWhatsApp("+918939479296", `Mock pricing doc link for ${call.args.detailsType}`)
                  .then((success) => {
                    // Send response back
                    session.conn.ws.send(JSON.stringify({
                      tool_response: {
                        function_responses: [
                          {
                            name: "sendWhatsAppDetails",
                            response: { output: { status: success ? "success" : "failed" } },
                            id: call.id
                          }
                        ]
                      }
                    }));
                    console.log("📤 Sent tool_response back to Gemini.");
                  });
              }
            }
          }

          // Detect output transcript to see if Gemini confirms it verbally
          if (data.serverContent?.outputTranscription?.text) {
            console.log(`🤖 Gemini: "${data.serverContent.outputTranscription.text}"`);
          }
        },
        onerror: (err) => {
          console.error("❌ Gemini error:", err);
        }
      }
    });

    console.log("Connected. Waiting 2 seconds...");

    setTimeout(() => {
      console.log("Sending user request: 'Can you send the pricing details on WhatsApp?'");
      session.conn.ws.send(JSON.stringify({
        client_content: {
          turns: [
            {
              role: "user",
              parts: [{ text: "Can you send the pricing details on WhatsApp?" }]
            }
          ],
          turn_complete: true
        }
      }));
    }, 2000);

    // Close after 12 seconds
    setTimeout(() => {
      console.log("Closing session...");
      session.close();
      process.exit(0);
    }, 12000);

  } catch (e) {
    console.error("Error:", e);
  }
}

test();
