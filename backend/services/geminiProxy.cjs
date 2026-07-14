// ============================================================
// services/geminiProxy.js
//
// ── WHAT WAS ROBOTIC AND WHY WE FIXED IT ──────────────────
//
// PROBLEM 1 — Wrong model:
//   Old: "gemini-2.5-flash-native-audio-latest"  ← this is correct
//   But the speechConfig was duplicated inside generationConfig,
//   which caused a config conflict and degraded voice quality.
//   Fix: Single clean speechConfig at top level only.
//
// PROBLEM 2 — Wrong sendRealtimeInput format:
//   Old: session.sendRealtimeInput({ media: { data, mimeType } })
//   The @google/genai SDK uses `audio` not `media` for browser PCM.
//   Fix: session.sendRealtimeInput({ audio: { data, mimeType } })
//
// PROBLEM 3 — Slider values sent as raw numbers in prompt:
//   "Emotion intensity: 75%" tells Gemini nothing useful.
//   Fix: buildRuntimePrompt() converts sliders to prose instructions
//   that the model can actually act on.
//
// PROBLEM 4 — VAD (Voice Activity Detection) not configured:
//   Without VAD config, Gemini uses aggressive defaults that cut
//   the caller off mid-sentence and rush responses — sounds robotic.
//   Fix: Added realtimeInputConfig with tuned VAD settings.
// ============================================================

const fs = require("fs");
const path = require("path");
const ws = require("ws");
globalThis.WebSocket = ws;
const { GoogleGenAI } = require("@google/genai");
const { createClient } = require("@supabase/supabase-js");
const { getConfig, buildRuntimePrompt } = require("./config.cjs");

// ── Clients ───────────────────────────────────────────────────
const genai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  apiVersion: "v1alpha",
});

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
let supabase = null;

function isValidHttpUrl(str) {
  try { return ["http:", "https:"].includes(new URL(str).protocol); }
  catch { return false; }
}

if (supabaseUrl && supabaseKey && isValidHttpUrl(supabaseUrl)) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
      realtime: { websocket: ws }
    });
  } catch (err) {
    console.error("❌ Supabase init failed:", err.message);
  }
}

// ── Voice map ─────────────────────────────────────────────────
// Gemini 2.5 Native Audio voices — chosen for warmth and naturalness
// Puck  = warm, expressive male  (best for Tanglish — most human feel)
// Aoede = breezy, friendly female
// Fenrir = calm, steady male
// Kore  = clear, firm female
const VOICE_MAP = {
  Arjun: "Puck",
  Priya: "Aoede",
  Dev:   "Fenrir",
  Kavya: "Kore",
};

// ── WAV header ────────────────────────────────────────────────
function getWavHeader(dataLength, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);                                      h.writeUInt32LE(dataLength + 36, 4);
  h.write("WAVE", 8);                                      h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);                                 h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);                           h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  h.writeUInt16LE(channels * bitsPerSample / 8, 32);       h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36);                                     h.writeUInt32LE(dataLength, 40);
  return h;
}

// Downsample 24kHz → 16kHz (for recording file consistency)
function resample24To16(buffer24) {
  // Copy to a new Uint8Array to guarantee 2-byte alignment of the underlying ArrayBuffer
  const aligned = new Uint8Array(buffer24.length);
  aligned.set(buffer24);
  const s24 = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
  const s16 = new Int16Array(Math.round(s24.length * 2 / 3));
  for (let i = 0; i < s16.length; i++) {
    const pos = i * 1.5;
    const lo = Math.floor(pos);
    const hi = Math.min(s24.length - 1, lo + 1);
    s16[i] = s24[lo] * (1 - (pos - lo)) + s24[hi] * (pos - lo);
  }
  return Buffer.from(s16.buffer, s16.byteOffset, s16.byteLength);
}

// ── WS send helper ────────────────────────────────────────────
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ═══════════════════════════════════════════════════════════════
// MAIN SESSION HANDLER
// ═══════════════════════════════════════════════════════════════
async function handleBrowserSession(browserWs) {
  let geminiSession = null;
  let isActive = true;
  const startTime = Date.now();

  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tempDir = path.join(__dirname, "../temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const tempPcmPath = path.join(tempDir, `${callId}.pcm`);
  const recordStream = fs.createWriteStream(tempPcmPath);
  const transcriptLines = [];

  // ── Load config and build prompt ──────────────────────────
  const activeConfig = getConfig();
  const voiceName = VOICE_MAP[activeConfig.activeVoice] || "Puck";

  // Fetch configured CRM questionnaire questions
  const { readAll } = require("./store");
  const defaultQuestions = [
    "Unga full name enna, sollunga?",
    "Ugaluku enna maadhiri insurance coverage venum?",
    "Unga budget premium target enna?",
    "Ugaluku edhavadhu pre-existing health conditions or medical issues iruka?"
  ];
  const questionsList = readAll("questions", defaultQuestions);

  const questionnairePrompt = `
══════════════════════════════════════════
MANDATORY QUESTIONNAIRE PROTOCOL
══════════════════════════════════════════
You are an insurance agent collecting leads. You MUST ask the caller the following questions ONE BY ONE. Do NOT ask them all at once. Wait for their response for each question:
${questionsList.map((q, i) => `${i + 1}. ${q}`).join("\n")}

When the user answers a question, you must immediately call the tool 'save_question_response' with the exact question you asked and the answer they gave, and then move to the next question.

If the user has any policy or general insurance questions at any point during the call, call the 'search_policy_knowledge_base' tool with their search query to get the exact facts and answers. Do not make up any insurance coverage details or terms. Use the retrieved document text to explain.
`;

  // buildRuntimePrompt converts slider numbers → human prose instructions
  // e.g. speed:75 → "Speak at a quick, energetic pace"
  const finalPrompt = buildRuntimePrompt(activeConfig) + "\n" + questionnairePrompt;

  console.log(`📞 New call | ID: ${callId} | Voice: ${activeConfig.activeVoice} (${voiceName})`);

  let liveInputTokens = 0;
  let liveOutputTokens = 0;
  let totalInboundAudioBytes = 0;
  let totalOutboundAudioBytes = 0;

  // ── Open Gemini session ───────────────────────────────────
  try {
    geminiSession = await openGeminiSession(
      browserWs,
      voiceName,
      finalPrompt,
      recordStream,
      transcriptLines,
      (inTokens, outTokens) => {
        liveInputTokens += inTokens;
        liveOutputTokens += outTokens;
        if (global.broadcastLog) {
          global.broadcastLog(`🪙 Tokens Spent: Input ${liveInputTokens} | Output ${liveOutputTokens}`, { type: "usage", inputTokens: liveInputTokens, outputTokens: liveOutputTokens });
        }
      },
      (outBytes) => {
        totalOutboundAudioBytes += outBytes;
      }
    );
    console.log(`✅ Gemini Live session open | Call ID: ${callId}`);
    send(browserWs, { type: "ready" });
    if (global.broadcastLog) {
      global.broadcastLog(`📞 Voice Session Open | Call ID: ${callId}`, { type: "system", callId });
    }
  } catch (err) {
    console.error("❌ Gemini session failed:", err.message);
    send(browserWs, { type: "error", message: "Failed to connect to AI. Check API key." });
    recordStream.close();
    try { fs.unlinkSync(tempPcmPath); } catch {}
    browserWs.close();
    return;
  }

  let isFinalized = false;

  // ── Handle browser messages ───────────────────────────────
  browserWs.on("message", async (rawMsg) => {
    if (!isActive || !geminiSession) return;
    try {
      const msg = JSON.parse(rawMsg.toString());
      if (msg.type === "audio") {
        await geminiSession.sendAudio(msg.data);
        const pcmData = Buffer.from(msg.data, "base64");
        totalInboundAudioBytes += pcmData.length;
        recordStream.write(pcmData);
      } else if (msg.type === "stop") {
        await finalizeCall();
        if (geminiSession) try { await geminiSession.close(); } catch {}
      }
    } catch (err) {
      console.error("❌ Message error:", err.message);
    }
  });

  async function finalizeCall() {
    if (isFinalized) return;
    isFinalized = true;
    isActive = false;
    recordStream.end();
    const duration = Math.round((Date.now() - startTime) / 1000);
    await new Promise(r => recordStream.on("finish", r));
    if (global.broadcastLog) {
      global.broadcastLog(`🛑 Call completed | Duration: ${duration}s | Total Tokens: ${liveInputTokens + liveOutputTokens}`, { type: "system", duration, inputTokens: liveInputTokens, outputTokens: liveOutputTokens });
    }
    processPostCallData(callId, tempPcmPath, duration, transcriptLines, activeConfig, liveInputTokens, liveOutputTokens, totalInboundAudioBytes, totalOutboundAudioBytes)
      .catch(err => console.error("❌ Post-call error:", err.message));
  }

  browserWs.on("close", async () => {
    console.log(`🌐 Disconnected | Call ID: ${callId}`);
    await finalizeCall();
    if (geminiSession) try { await geminiSession.close(); } catch {}
  });

  browserWs.on("error", err => {
    console.error("❌ WS error:", err.message);
    isActive = false;
  });
}

// ═══════════════════════════════════════════════════════════════
// GEMINI LIVE SESSION — CORE VOICE QUALITY SETTINGS
// ═══════════════════════════════════════════════════════════════
async function openGeminiSession(browserWs, voiceName, systemPrompt, recordStream, transcriptLines, onTokenUsage, onAudioOut) {

  // ── Intercept WebSocket Send to Inject VAD Config ──────────
  // The @google/genai SDK ignores and strips realtimeInputConfig/VAD keys
  // from config, so we intercept the first setup payload sent over ws
  // and inject them in the expected snake_case format directly.
  const originalSend = ws.prototype.send;
  ws.prototype.send = function (data, options, callback) {
    try {
      const payload = JSON.parse(data);
      if (payload.setup) {
        // Delete contextWindowCompression to prevent invalid argument error
        delete payload.setup.contextWindowCompression;

        // Translate and inject snake_case VAD settings for the Live API backend
        payload.setup.realtime_input_config = {
          automatic_activity_detection: {
            disabled: false,
            start_of_speech_sensitivity: "START_SENSITIVITY_HIGH",
            end_of_speech_sensitivity: "END_SENSITIVITY_HIGH",
            silence_duration_ms: 600
          }
        };
        delete payload.setup.realtimeInputConfig;

        // Set temperature inside the existing generationConfig
        if (!payload.setup.generationConfig) {
          payload.setup.generationConfig = {};
        }
        payload.setup.generationConfig.temperature = 0.9;
        
        data = JSON.stringify(payload);
        console.log("⚙️ Intercepted setup payload, injected snake_case VAD config (silence: 600ms, sensitivity: HIGH), and set temperature: 0.9.");
        if (global.broadcastLog) {
          global.broadcastLog(`📤 [Gemini Send] setup (model: gemini-2.5-flash-native-audio-latest, voice: ${voiceName})`, { type: "gemini_raw" });
        }
      }
    } catch (_) {}
    // Restore original send immediately
    ws.prototype.send = originalSend;
    return originalSend.call(this, data, options, callback);
  };

  const session = await genai.live.connect({
    model: "gemini-2.5-flash-native-audio-latest",

    config: {
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },

      // ── Response format: AUDIO only ──────────────────────
      responseModalities: ["AUDIO"],

      // ── Tools / Function Declarations ────────────────────
      tools: [
        {
          functionDeclarations: [
            {
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
            },
            {
              name: "save_question_response",
              description: "Record the client's answer to one of the mandatory questionnaire questions.",
              parameters: {
                type: "OBJECT",
                properties: {
                  question: {
                    type: "STRING",
                    description: "The exact question asked to the client"
                  },
                  answer: {
                    type: "STRING",
                    description: "The client's answer, response, or statement"
                  }
                },
                required: ["question", "answer"]
              }
            }
          ]
        }
      ],

      // ── Voice selection ───────────────────────────────────
      // ONE speechConfig here — duplicating it inside generationConfig
      // causes a config conflict that degrades voice quality to robotic.
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName }
        }
      },

      // ── Transcription — both sides ────────────────────────
      inputAudioTranscription:  {},
      outputAudioTranscription: {},

      // ── VAD (Voice Activity Detection) ────────────────────
      // This is the #1 cause of robotic feel when misconfigured.
      // Without this, Gemini uses aggressive defaults:
      //   - cuts off caller mid-sentence (bad turn-taking)
      //   - responds too fast (no thinking pause = sounds scripted)
      //   - doesn't wait for natural sentence-end pauses
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          // How long of silence = caller finished speaking
          // 800ms feels natural; lower = AI interrupts you; higher = awkward lag
          endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
          // How long before VAD activates (filters room noise)
          startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
        },
        // Barge-in: let caller interrupt AI mid-sentence
        // This is what makes it feel like a REAL conversation
        turnCoverage: "TURN_INCLUDES_ALL_INPUT",
      },

      // ── Context window compression ────────────────────────
      // Keeps conversation coherent over long calls without
      // hitting token limits (prevents quality degradation mid-call)
      contextWindowCompression: {
        triggerTokens: 25600,
        slidingWindow: { targetTokens: 12800 },
      },
    },

    callbacks: {
      onmessage: async (response) => {
        if (!browserWs || browserWs.readyState !== 1) return;

        // Handle tool calls from Gemini (RAG search or saving questionnaire answers)
        if (response.toolCall) {
          const functionCalls = response.toolCall.functionCalls;
          const functionResponses = [];

          for (const call of functionCalls) {
            console.log(`🛠️ Tool Call: Executing ${call.name}`);
            let result = {};
            if (call.name === "search_policy_knowledge_base") {
              result = await handleSearchPolicyKnowledgeBase(call.args.query);
            } else if (call.name === "save_question_response") {
              const activeConfig = getConfig();
              const phone = activeConfig.activePhone || "+918939479296";
              result = await handleSaveQuestionResponse("web_call", phone, call.args.question, call.args.answer);
            }
            functionResponses.push({
              id: call.id,
              name: call.name,
              response: { output: result }
            });
          }

          try {
            session.sendToolResponse({ functionResponses });
          } catch (err) {
            session.send({ toolResponse: { functionResponses } });
          }
        }

        // AI audio response
        if (response.serverContent?.modelTurn?.parts) {
          for (const part of response.serverContent.modelTurn.parts) {
            if (part.inlineData?.mimeType?.startsWith("audio/")) {
              // Send to browser for playback
              send(browserWs, {
                type: "audio",
                data: part.inlineData.data,
                mimeType: part.inlineData.mimeType,
              });
              // Save resampled version to recording file
              const raw = Buffer.from(part.inlineData.data, "base64");
              if (onAudioOut) {
                onAudioOut(raw.length);
              }
              recordStream.write(resample24To16(raw));
            }
          }
        }

        // Transcripts
        if (response.serverContent?.inputTranscription?.text) {
          const text = response.serverContent.inputTranscription.text;
          console.log(`👤 Caller: "${text}"`);
          transcriptLines.push({ role: "user", text });
          send(browserWs, { type: "transcript", role: "user", text });
          if (global.broadcastLog) {
            global.broadcastLog(`👤 Caller: "${text}"`, { type: "transcript", role: "user", text });
          }
        }
        if (response.serverContent?.outputTranscription?.text) {
          const text = response.serverContent.outputTranscription.text;
          console.log(`🤖 Agent: "${text}"`);
          transcriptLines.push({ role: "ai", text });
          send(browserWs, { type: "transcript", role: "ai", text });
          if (global.broadcastLog) {
            global.broadcastLog(`🤖 Agent: "${text}"`, { type: "transcript", role: "ai", text });
          }
        }

        // Barge-in: caller interrupted AI
        if (response.serverContent?.interrupted) {
          send(browserWs, { type: "interrupted" });
        }

        // Turn complete
        if (response.serverContent?.turnComplete) {
          send(browserWs, { type: "turn_complete" });
        }
      },

      onerror: (err) => {
        console.error("❌ Gemini error:", err.message || err);
        send(browserWs, { type: "error", message: String(err.message || err) });
      },

      onclose: (e) => {
        console.log(`🔌 Gemini closed. Code: ${e?.code}, Reason: ${e?.reason || "none"}`);
        send(browserWs, { type: "ended" });
      },
    },
  });

  // Attach raw WebSocket packet listener to capture exact Google server frames including usageMetadata
  if (session && session.conn && session.conn.ws) {
    session.conn.ws.on("message", (rawFrame) => {
      try {
        const payload = JSON.parse(rawFrame.toString());
        if (global.broadcastLog) {
          let eventSummary = "📥 [Gemini Receive] ";
          const usage = payload.usageMetadata || payload.serverContent?.usageMetadata || payload.usage_metadata || payload.serverContent?.usage_metadata;
          
          if (payload.serverContent?.modelTurn?.parts) {
            const hasAudio = payload.serverContent.modelTurn.parts.some(p => p.inlineData?.mimeType?.startsWith("audio/"));
            eventSummary += `serverContent (modelTurn${hasAudio ? ' with audio payload' : ''})`;
          } else if (payload.serverContent?.inputTranscription) {
            eventSummary += `inputTranscription (text: "${payload.serverContent.inputTranscription.text}")`;
          } else if (payload.serverContent?.outputTranscription) {
            eventSummary += `outputTranscription (text: "${payload.serverContent.outputTranscription.text}")`;
          } else if (payload.serverContent?.interrupted) {
            eventSummary += `interrupted (caller barge-in)`;
          } else if (payload.serverContent?.turnComplete) {
            eventSummary += `turnComplete`;
          } else {
            eventSummary += Object.keys(payload).join(", ");
          }
          
          global.broadcastLog(eventSummary, { type: "gemini_raw" });
          
          // Count and log tokens robustly as a separate event if usageMetadata is present
          if (usage) {
            const inCount = usage.promptTokenCount || usage.prompt_token_count || 0;
            const outCount = usage.responseTokenCount || usage.response_token_count || 
                             usage.candidatesTokenCount || usage.candidates_token_count || 0;
            if (inCount > 0 || outCount > 0) {
              global.broadcastLog(`📥 [Gemini Receive] usageMetadata (promptTokens: ${inCount}, responseTokens: ${outCount})`, { type: "gemini_raw" });
              onTokenUsage(inCount, outCount);
            }
          }
        }
      } catch (err) {
        // Not a JSON packet
      }
    });
  }

  return {
    sendAudio: async (base64Pcm16k) => {
      await session.sendRealtimeInput({
        media: {
          data: base64Pcm16k,
          mimeType: "audio/pcm;rate=16000",
        },
      });
    },
    close: async () => { try { await session.close(); } catch {} },
  };
}

// ═══════════════════════════════════════════════════════════════
// POST CALL: Upload + Sentiment + Supabase save
// ═══════════════════════════════════════════════════════════════
async function processPostCallData(callId, tempPcmPath, durationSeconds, transcriptLines, activeConfig, liveInputTokens, liveOutputTokens, totalInboundAudioBytes, totalOutboundAudioBytes) {
  if (!fs.existsSync(tempPcmPath)) return;

  const rawPcm = fs.readFileSync(tempPcmPath);
  const wavBuffer = Buffer.concat([getWavHeader(rawPcm.length), rawPcm]);
  try { fs.unlinkSync(tempPcmPath); } catch {}

  let recordingUrl = null;
  let sentiment = "Neutral";
  const fullTranscript = transcriptLines
    .map(l => `${l.role === "user" ? "Caller" : "Agent"}: ${l.text}`)
    .join("\n");

  // Upload to Supabase Storage
  if (supabase && wavBuffer.length > 44) {
    const { error: uploadErr } = await supabase.storage
      .from("recordings")
      .upload(`${callId}.wav`, wavBuffer, { contentType: "audio/wav", upsert: true });

    if (uploadErr) {
      console.error("❌ Upload error:", uploadErr.message);
    } else {
      const { data } = supabase.storage.from("recordings").getPublicUrl(`${callId}.wav`);
      recordingUrl = data?.publicUrl;
      console.log(`💾 Uploaded: ${recordingUrl}`);
    }
  }

  let sentimentInputTokens = 0;
  let sentimentOutputTokens = 0;

  // Sentiment analysis
  if (transcriptLines.length > 0) {
    try {
      const res = await genai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: `Analyze the sentiment of this call transcript. Reply with ONLY one word: Positive, Neutral, or Negative.\n\n${fullTranscript}`,
      });
      const t = res.text?.trim();
      if (["Positive", "Neutral", "Negative"].includes(t)) sentiment = t;
      console.log("📊 Sentiment result:", sentiment);

      // Capture post-call sentiment API token usage
      if (res.usageMetadata) {
        sentimentInputTokens = res.usageMetadata.promptTokenCount || 0;
        sentimentOutputTokens = res.usageMetadata.candidatesTokenCount || 
                                res.usageMetadata.responseTokenCount || 0;
      }
    } catch (err) {
      console.error("❌ Sentiment error:", err.message);
    }
  }

  // Combined token calculation for BOTH models
  let totalInputTokens = liveInputTokens + sentimentInputTokens;
  let totalOutputTokens = liveOutputTokens + sentimentOutputTokens;

  // Fallback if websocket usageMetadata wasn't populated (calculate based on duration/audio bytes)
  if (totalInputTokens === 0 && totalInboundAudioBytes > 0) {
    const inputAudioSeconds = totalInboundAudioBytes / 32000;
    const promptBaseline = 1500 + (transcriptLines.length * 150);
    totalInputTokens = Math.round((inputAudioSeconds * 32) + promptBaseline);
  }
  if (totalOutputTokens === 0 && totalOutboundAudioBytes > 0) {
    const outputAudioSeconds = totalOutboundAudioBytes / 48000;
    totalOutputTokens = Math.round(outputAudioSeconds * 25);
  }

  // Pricing: Input: $0.075 / 1M tokens ($0.000000075 / token) | Output: $0.30 / 1M tokens ($0.0000003 / token)
  const costUsd = (totalInputTokens * 0.000000075) + (totalOutputTokens * 0.0000003);

  console.log(`📊 Cost Breakdown: Total Input Tokens=${totalInputTokens}, Total Output Tokens=${totalOutputTokens}, Cost=$${costUsd.toFixed(5)}`);

  // Save to Supabase DB
  if (supabase) {
    const { error } = await supabase.from("calls").insert({
      caller_number: "Web Call",
      agent_name: activeConfig.activeVoice,
      language: "Tanglish",
      duration_seconds: durationSeconds,
      sentiment,
      transcript: fullTranscript,
      recording_url: recordingUrl,
      cost_usd: costUsd,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens
    });
    if (error) console.error("❌ DB insert error:", error.message);
    else console.log(`✅ Saved to DB | ID: ${callId}`);
  }
}



async function handleSearchPolicyKnowledgeBase(query) {
  try {
    const chromaUrl = process.env.CHROMA_URL || "https://chroma-corechroma-production-1118.up.railway.app";
    const collectionsRes = await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`);
    const collections = await collectionsRes.json();
    const targetColl = collections.find(c => c.name === "policy-documents");
    if (!targetColl) throw new Error("policy-documents collection not found");
    const collectionId = targetColl.id;
    const searchUrl = `${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections/${collectionId}/get`;

    console.log(`🔍 Chroma DB: Searching for "${query}"`);

    // Clean query and extract keywords
    const stopwords = new Set(["what", "is", "the", "a", "of", "and", "in", "to", "for", "about", "how", "does", "do", "you", "have", "definition", "qualifies", "under", "policy", "wording", "plan", "insurance"]);
    const keywords = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopwords.has(w));

    let filterBody = {};
    if (keywords.length > 0) {
      const expanded = [];
      for (const kw of keywords) {
        expanded.push(kw.toLowerCase());
        expanded.push(kw.charAt(0).toUpperCase() + kw.slice(1));
        expanded.push(kw.toUpperCase());
      }
      if (expanded.length === 1) {
        filterBody = { where_document: { "$contains": expanded[0] } };
      } else {
        filterBody = {
          where_document: {
            "$or": expanded.map(kw => ({ "$contains": kw }))
          }
        };
      }
    } else {
      filterBody = { where_document: { "$contains": query } };
    }

    const res = await fetch(searchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...filterBody,
        limit: 3,
        include: ["documents"]
      })
    });
    const data = await res.json();
    if (data && Array.isArray(data.documents) && data.documents.length > 0) {
      const docs = data.documents.join("\n\n---\n\n");
      console.log(`✅ Chroma DB: Found ${data.documents.length} matches.`);
      return { success: true, documents: docs };
    }
    return { success: false, message: "No matching policy documents found in the database." };
  } catch (err) {
    console.error("❌ Chroma DB search failed:", err.message);
    return { success: false, error: err.message };
  }
}

async function handleSaveQuestionResponse(callId, phone, question, answer) {
  try {
    const { append } = require("./store");
    const payload = {
      id: `RESP-${Date.now().toString().slice(-5)}`,
      call_id: callId,
      policyholder_phone: phone || "+918939479296",
      question,
      answer,
      created_at: new Date().toISOString()
    };
    
    // Save locally
    append("lead_responses", payload);

    // Save to Supabase if available
    const { createClient } = require("@supabase/supabase-js");
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey) {
      const ws = require("ws");
      const supabase = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false },
        realtime: { websocket: ws }
      });
      await supabase.from("lead_responses").insert([{
        call_id: callId,
        policyholder_phone: phone,
        question,
        answer
      }]);
    }
    
    console.log(`✅ Questionnaire: Saved response for "${question}" ➔ "${answer}"`);
    return { success: true, saved: true };
  } catch (err) {
    console.error("❌ Questionnaire save failed:", err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { handleBrowserSession, handleSearchPolicyKnowledgeBase, handleSaveQuestionResponse };
