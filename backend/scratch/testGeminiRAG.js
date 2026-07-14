const { GoogleGenAI } = require("@google/genai");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const { handleSearchPolicyKnowledgeBase } = require("../services/geminiProxy");

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY is not defined in your .env file!");
    return;
  }

  const genai = new GoogleGenAI({ apiKey });
  const model = "gemini-2.5-flash";

  console.log("🤖 Asking Gemini: 'What is the definition of an Accident in the policy?'\n");

  try {
    // 1. Initial request to Gemini
    const response = await genai.models.generateContent({
      model,
      contents: "What is the definition of an Accident in the policy?",
      config: {
        tools: [{
          functionDeclarations: [{
            name: "search_policy_knowledge_base",
            description: "Search the insurance policy documents database for definitions, policy terms, coverages, limits, and rules.",
            parameters: {
              type: "OBJECT",
              properties: {
                query: {
                  type: "STRING",
                  description: "Specific search terms or keywords to query in the insurance policy database"
                }
              },
              required: ["query"]
            }
          }]
        }]
      }
    });

    // 2. Check if model wants to call a tool
    const functionCalls = response.functionCalls;
    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      console.log(`📡 Gemini requested tool call: ${call.name} with args:`, call.args);

      if (call.name === "search_policy_knowledge_base") {
        // Run local RAG query
        const searchResult = await handleSearchPolicyKnowledgeBase(call.args.query);
        console.log("🔑 RAG Result returned from Chroma DB:", searchResult);

        // 3. Send tool response back to Gemini to get final answer
        const finalResponse = await genai.models.generateContent({
          model,
          contents: [
            { role: "user", parts: [{ text: "What is the definition of an Accident in the policy?" }] },
            response.candidates[0].content, // contains the function call
            {
              role: "user",
              parts: [{
                functionResponse: {
                  name: "search_policy_knowledge_base",
                  response: { result: searchResult }
                }
              }]
            }
          ]
        });

        console.log("\n💬 Gemini's Final Answer:");
        console.log(finalResponse.text);
      }
    } else {
      console.log("No tool call requested. Gemini responded with:", response.text);
    }
  } catch (err) {
    console.error("❌ Error running Gemini RAG test:", err.message);
  }
}

main();
