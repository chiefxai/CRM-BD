// scratch/testSession.js
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
    console.log("Session keys:", Object.keys(session));
    console.log("Session prototype keys:", Object.keys(Object.getPrototypeOf(session)));
    await session.close();
  } catch (e) {
    console.error("Error connecting:", e);
  }
}

test();
