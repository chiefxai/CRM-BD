// scratch/inspectConn.js
require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");

const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  apiVersion: "v1alpha",
});

async function test() {
  try {
    const session = await genai.live.connect({
      model: "gemini-2.5-flash-native-audio-latest"
    });
    console.log("session.conn constructor name:", session.conn.constructor.name);
    console.log("session.conn keys:", Object.keys(session.conn));
    console.log("session.conn prototype keys:", Object.keys(Object.getPrototypeOf(session.conn)));
    await session.close();
  } catch (e) {
    console.error("Error:", e);
  }
}

test();
