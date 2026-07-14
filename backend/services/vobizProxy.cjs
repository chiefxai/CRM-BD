// services/vobizProxy.js
// ============================================================
// Vobiz.ai WebSocket Proxy & Telephony Handler for Gemini Live API
// ============================================================

const fs = require("fs");
const path = require("path");
const ws = require("ws");
globalThis.WebSocket = ws;
const { GoogleGenAI } = require("@google/genai");
const { createClient } = require("@supabase/supabase-js");
const { getConfig, buildRuntimePrompt } = require("./config.cjs");
const {
  mulawToPcm16,
  pcm16ToMulaw,
  upsample8To16,
  downsample24To8
} = require("./audioConverter.cjs");

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
    console.error("❌ Supabase init failed in vobizProxy:", err.message);
  }
}

const VOICE_MAP = {
  Arjun: "Puck",
  Priya: "Aoede",
  Dev:   "Fenrir",
  Kavya: "Kore",
};

// In-memory cache for caller phone numbers mapping CallSid/CallUUID -> From
const vobizCallNumbers = new Map();

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

function resample24To16(buffer24) {
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

function sendJson(wsConn, obj) {
  if (wsConn.readyState === 1) wsConn.send(JSON.stringify(obj));
}

// ═══════════════════════════════════════════════════════════════
// MAIN VOBIZ SESSION HANDLER
// ═══════════════════════════════════════════════════════════════
async function handleVobizSession(vobizWs) {
  let isActive = true;
  let streamSid = null;
  let callSid = null;
  const startTime = Date.now();

  const callId = `call_vobiz_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tempDir = path.join(__dirname, "../temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const tempPcmPath = path.join(tempDir, `${callId}.pcm`);
  const recordStream = fs.createWriteStream(tempPcmPath);
  const transcriptLines = [];

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

  const finalPrompt = buildRuntimePrompt(activeConfig) + "\n" + questionnairePrompt;

  console.log(`📞 New Vobiz voice connection. Voice: ${activeConfig.activeVoice} (${voiceName})`);

  let geminiSetupFinished = false;

  const triggerGreetingIfReady = async () => {
    if (geminiSetupFinished && streamSid) {
      const geminiSession = await geminiSessionPromise;
      if (geminiSession) {
        try {
          console.log("👋 Triggering custom warm greeting...");
          const now = new Date();
          const hour = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000).getHours();
          let timeOfDay = "morning";
          if (hour >= 12 && hour < 16) {
            timeOfDay = "afternoon";
          } else if (hour >= 16 && hour < 20) {
            timeOfDay = "evening";
          } else if (hour >= 20 || hour < 5) {
            timeOfDay = "night";
          }
          
          const greetingText = `Vanakkam sir/mam, ${timeOfDay}! Naanga ChiefVoice-la irundhu call panrom. Sollunga, enna assist venum, epdi help pannalam?`;
          await geminiSession.sendText(greetingText);
        } catch (e) {
          console.error("Failed to trigger initial greeting:", e.message);
        }
      }
    }
  };

  let liveInputTokens = 0;
  let liveOutputTokens = 0;
  let totalInboundAudioBytes = 0;
  let totalOutboundAudioBytes = 0;

  // Start connecting to Gemini
  const geminiSessionPromise = openGeminiSession(
    vobizWs,
    voiceName,
    finalPrompt,
    recordStream,
    transcriptLines,
    callId,
    (inTokens, outTokens) => {
      liveInputTokens += inTokens;
      liveOutputTokens += outTokens;
      if (global.broadcastLog) {
        global.broadcastLog(`🪙 Tokens Spent: Input ${liveInputTokens} | Output ${liveOutputTokens}`, { type: "usage", inputTokens: liveInputTokens, outputTokens: liveOutputTokens });
      }
    },
    (outBytes) => {
      totalOutboundAudioBytes += outBytes;
    },
    () => {
      geminiSetupFinished = true;
      triggerGreetingIfReady();
    },
    () => vobizCallNumbers.get(callSid) || "Vobiz Call"
  ).then(session => {
    console.log(`✅ Gemini Live session open for Vobiz | Call ID: ${callId}`);
    if (global.broadcastLog) {
      global.broadcastLog(`📞 Voice Session Open | Call ID: ${callId}`, { type: "system", callId });
    }
    return session;
  }).catch(err => {
    console.error("❌ Gemini session failed for Vobiz:", err.message);
    recordStream.close();
    try { fs.unlinkSync(tempPcmPath); } catch {}
    vobizWs.close();
    return null;
  });

  let isFinalized = false;

  vobizWs.on("message", async (rawMsg) => {
    if (!isActive) return;
    try {
      const msg = JSON.parse(rawMsg.toString());
      
      switch (msg.event) {
        case "start":
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          console.log(`🚀 Vobiz Stream started: ${streamSid} | CallSid/UUID: ${callSid}`);
          triggerGreetingIfReady();
          break;

        case "media":
          if (msg.media.track === "inbound") {
            const geminiSession = await geminiSessionPromise;
            if (!geminiSession) return;

            const rawMulaw = Buffer.from(msg.media.payload, "base64");
            
            // 1. Convert G.711 u-law (8kHz) -> PCM 16-bit (8kHz)
            const pcm8k = mulawToPcm16(rawMulaw);

            // 2. Upsample PCM 16-bit 8kHz -> PCM 16-bit 16kHz for Gemini
            const pcm16k = upsample8To16(pcm8k);

            // 3. Send to Gemini
            await geminiSession.sendAudio(pcm16k.toString("base64"));
            totalInboundAudioBytes += pcm16k.length;

            // 4. Save to recording file
            recordStream.write(pcm16k);
          }
          break;

        case "stop":
          console.log(`🔌 Vobiz Stream stopped: ${streamSid}`);
          await finalizeCall();
          const geminiSession = await geminiSessionPromise;
          if (geminiSession) try { await geminiSession.close(); } catch {}
          break;
      }
    } catch (err) {
      console.error("❌ Vobiz Message error:", err.message);
    }
  });

  async function finalizeCall() {
    if (isFinalized) return;
    isFinalized = true;
    isActive = false;
    recordStream.end();
    const duration = Math.round((Date.now() - startTime) / 1000);
    await new Promise(r => recordStream.on("finish", r));

    const callerNumber = vobizCallNumbers.get(callSid) || "Vobiz Call";
    vobizCallNumbers.delete(callSid); // clean up

    if (global.broadcastLog) {
      global.broadcastLog(`🛑 Call completed | Caller: ${callerNumber} | Duration: ${duration}s | Total Tokens: ${liveInputTokens + liveOutputTokens}`, { type: "system", duration, inputTokens: liveInputTokens, outputTokens: liveOutputTokens });
    }

    processPostCallData(callId, callerNumber, tempPcmPath, duration, transcriptLines, activeConfig, liveInputTokens, liveOutputTokens, totalInboundAudioBytes, totalOutboundAudioBytes)
      .catch(err => console.error("❌ Post-call error for Vobiz:", err.message));
  }

  vobizWs.on("close", async () => {
    console.log(`🌐 Vobiz WS closed | Call ID: ${callId}`);
    await finalizeCall();
    const geminiSession = await geminiSessionPromise;
    if (geminiSession) try { await geminiSession.close(); } catch {}
  });

  vobizWs.on("error", err => {
    console.error("❌ Vobiz WS error:", err.message);
    isActive = false;
  });
}

// GEMINI LIVE SESSION
// ═══════════════════════════════════════════════════════════════
async function openGeminiSession(vobizWs, voiceName, systemPrompt, recordStream, transcriptLines, callId, onTokenUsage, onAudioOut, onSetupComplete, getCallerNumber) {
  const outboundQueue = [];
  let intervalId = null;

  const startPacing = () => {
    if (intervalId) return;
    intervalId = setInterval(() => {
      // 160 bytes of G.711 mu-law represents 20ms of audio at 8kHz
      if (outboundQueue.length >= 160) {
        const chunk = Buffer.from(outboundQueue.splice(0, 160));
        sendJson(vobizWs, {
          event: "playAudio",
          media: {
            contentType: "audio/x-mulaw",
            sampleRate: 8000,
            payload: chunk.toString("base64")
          }
        });
      }
    }, 20);
  };

  const stopPacing = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    outboundQueue.length = 0;
  };

  // Inject VAD config
  const originalSend = ws.prototype.send;
  ws.prototype.send = function (data, options, callback) {
    try {
      const payload = JSON.parse(data);
      if (payload.setup) {
        delete payload.setup.contextWindowCompression;

        payload.setup.realtime_input_config = {
          automatic_activity_detection: {
            disabled: false,
            start_of_speech_sensitivity: "START_SENSITIVITY_HIGH",
            end_of_speech_sensitivity: "END_SENSITIVITY_HIGH",
            silence_duration_ms: 600
          }
        };
        delete payload.setup.realtimeInputConfig;

        if (!payload.setup.generationConfig) {
          payload.setup.generationConfig = {};
        }
        payload.setup.generationConfig.temperature = 0.9;
        
        data = JSON.stringify(payload);
        console.log("⚙️ Vobiz Stream: Injected low-latency VAD config.");
        if (global.broadcastLog) {
          global.broadcastLog(`📤 [Gemini Send] setup (model: gemini-2.5-flash-native-audio-latest, voice: ${voiceName})`, { type: "gemini_raw" });
        }
      }
    } catch (_) {}
    ws.prototype.send = originalSend;
    return originalSend.call(this, data, options, callback);
  };

  const session = await genai.live.connect({
    model: "gemini-2.5-flash-native-audio-latest",
    config: {
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      responseModalities: ["AUDIO"],
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
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName }
        }
      },
      inputAudioTranscription:  {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
          startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
        },
        turnCoverage: "TURN_INCLUDES_ALL_INPUT",
      },
      contextWindowCompression: {
        triggerTokens: 25600,
        slidingWindow: { targetTokens: 12800 },
      },
    },
    callbacks: {
      onmessage: async (response) => {
        // Handle tool calls
        if (response.toolCall) {
          const functionCalls = response.toolCall.functionCalls;
          const functionResponses = [];

          for (const call of functionCalls) {
            console.log(`🛠️ Vobiz Tool Call: Executing ${call.name}`);
            let result = {};
            if (call.name === "search_policy_knowledge_base") {
              result = await handleSearchPolicyKnowledgeBase(call.args.query);
            } else if (call.name === "save_question_response") {
              const phone = getCallerNumber ? getCallerNumber() : "Vobiz Call";
              result = await handleSaveQuestionResponse(callId, phone, call.args.question, call.args.answer);
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

        if (response.setupComplete) {
          console.log("⚙️ Gemini Setup Complete. Ready for Vobiz greeting.");
          if (onSetupComplete) onSetupComplete();
        }

        if (!vobizWs || vobizWs.readyState !== 1) return;

        // AI audio response
        if (response.serverContent?.modelTurn?.parts) {
          for (const part of response.serverContent.modelTurn.parts) {
            if (part.inlineData?.mimeType?.startsWith("audio/")) {
              const raw24kPCM = Buffer.from(part.inlineData.data, "base64");
              if (onAudioOut) {
                onAudioOut(raw24kPCM.length);
              }
              
              // 1. Resample: 24kHz PCM -> 8kHz PCM
              const pcm8k = downsample24To8(raw24kPCM);

              // 2. Encode: 8kHz PCM -> 8kHz G.711 u-law
              const mulaw8k = pcm16ToMulaw(pcm8k);

              // 3. Queue bytes
              for (let i = 0; i < mulaw8k.length; i++) {
                outboundQueue.push(mulaw8k[i]);
              }
              startPacing();

              // Save to recording file
              recordStream.write(resample24To16(raw24kPCM));
            }
          }
        }

        // Transcripts
        if (response.serverContent?.inputTranscription?.text) {
          const text = response.serverContent.inputTranscription.text;
          console.log(`👤 Vobiz Caller: "${text}"`);
          transcriptLines.push({ role: "user", text });
          if (global.broadcastLog) {
            global.broadcastLog(`👤 Caller: "${text}"`, { type: "transcript", role: "user", text });
          }
        }
        if (response.serverContent?.outputTranscription?.text) {
          const text = response.serverContent.outputTranscription.text;
          console.log(`🤖 Agent to Vobiz: "${text}"`);
          transcriptLines.push({ role: "ai", text });
          if (global.broadcastLog) {
            global.broadcastLog(`🤖 Agent: "${text}"`, { type: "transcript", role: "ai", text });
          }
        }

        // Barge-in: caller interrupted AI
        if (response.serverContent?.interrupted) {
          stopPacing();
          sendJson(vobizWs, {
            event: "clearAudio"
          });
        }
      },
      onerror: (err) => {
        console.error("❌ Gemini error in Vobiz call:", err.message || err);
      },
      onclose: (e) => {
        console.log(`🔌 Gemini closed for Vobiz. Code: ${e?.code}, Reason: ${e?.reason || "none"}`);
        stopPacing();
      },
    },
  });

  // Attach packet listener for usage logs
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
      } catch (err) {}
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
    sendText: async (text) => {
      if (session.conn && session.conn.ws && session.conn.ws.readyState === 1) {
        session.conn.ws.send(JSON.stringify({
          client_content: {
            turns: [
              {
                role: "user",
                parts: [{ text: text }]
              }
            ],
            turn_complete: true
          }
        }));
      }
    },
    close: async () => {
      stopPacing();
      try { await session.close(); } catch {}
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// POST CALL DATA HANDLING
// ═══════════════════════════════════════════════════════════════
async function processPostCallData(callId, callerNumber, tempPcmPath, durationSeconds, transcriptLines, activeConfig, liveInputTokens, liveOutputTokens, totalInboundAudioBytes, totalOutboundAudioBytes) {
  if (!fs.existsSync(tempPcmPath)) return;

  const rawPcm = fs.readFileSync(tempPcmPath);
  const wavBuffer = Buffer.concat([getWavHeader(rawPcm.length), rawPcm]);
  try { fs.unlinkSync(tempPcmPath); } catch {}

  let recordingUrl = null;
  let sentiment = "Neutral";
  const fullTranscript = transcriptLines
    .map(l => `${l.role === "user" ? "Caller" : "Agent"}: ${l.text}`)
    .join("\n");

  if (supabase && wavBuffer.length > 44) {
    const { error: uploadErr } = await supabase.storage
      .from("recordings")
      .upload(`${callId}.wav`, wavBuffer, { contentType: "audio/wav", upsert: true });

    if (uploadErr) {
      console.error("❌ Vobiz upload error:", uploadErr.message);
    } else {
      const { data } = supabase.storage.from("recordings").getPublicUrl(`${callId}.wav`);
      recordingUrl = data?.publicUrl;
      console.log(`💾 Vobiz recording uploaded: ${recordingUrl}`);
    }
  }

  let sentimentInputTokens = 0;
  let sentimentOutputTokens = 0;

  if (transcriptLines.length > 0) {
    try {
      const res = await genai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: `Analyze the sentiment of this call transcript. Reply with ONLY one word: Positive, Neutral, or Negative.\n\n${fullTranscript}`,
      });
      const t = res.text?.trim();
      if (["Positive", "Neutral", "Negative"].includes(t)) sentiment = t;
      console.log(`📊 Vobiz Sentiment: ${sentiment}`);

      if (res.usageMetadata) {
        sentimentInputTokens = res.usageMetadata.promptTokenCount || 0;
        sentimentOutputTokens = res.usageMetadata.candidatesTokenCount || 
                                res.usageMetadata.responseTokenCount || 0;
      }
    } catch (err) {
      console.error("❌ Vobiz Sentiment error:", err.message);
    }
  }

  let totalInputTokens = liveInputTokens + sentimentInputTokens;
  let totalOutputTokens = liveOutputTokens + sentimentOutputTokens;

  if (totalInputTokens === 0 && totalInboundAudioBytes > 0) {
    const inputAudioSeconds = totalInboundAudioBytes / 32000;
    const promptBaseline = 1500 + (transcriptLines.length * 150);
    totalInputTokens = Math.round((inputAudioSeconds * 32) + promptBaseline);
  }
  if (totalOutputTokens === 0 && totalOutboundAudioBytes > 0) {
    const outputAudioSeconds = totalOutboundAudioBytes / 48000;
    totalOutputTokens = Math.round(outputAudioSeconds * 25);
  }

  const costUsd = (totalInputTokens * 0.000000075) + (totalOutputTokens * 0.0000003);

  console.log(`📊 Cost Breakdown (Vobiz): InputTokens=${totalInputTokens}, OutputTokens=${totalOutputTokens}, Cost=$${costUsd.toFixed(5)}`);

  if (supabase) {
    const { error } = await supabase.from("calls").insert({
      caller_number: callerNumber,
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
    if (error) console.error("❌ Vobiz DB insert error:", error.message);
    else console.log(`✅ Vobiz call saved to DB | ID: ${callId}`);
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

    const chromaRes = await fetch(searchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...filterBody,
        limit: 3,
        include: ["documents", "metadatas"]
      })
    });

    return await chromaRes.json();
  } catch (err) {
    console.error("Chroma search failed in vobizProxy:", err.message);
    return { error: err.message };
  }
}

async function handleSaveQuestionResponse(callId, phone, question, answer) {
  try {
    const payload = {
      call_id: callId,
      policyholder_phone: phone,
      question,
      answer
    };
    
    // Save to local JSON store
    const { append } = require("./store");
    append("lead_responses", {
      id: `RESP-${Date.now().toString().slice(-5)}`,
      created_at: new Date().toISOString(),
      ...payload
    });

    if (supabase) {
      const { error } = await supabase.from("lead_responses").insert([payload]);
      if (error) console.error("Supabase insert error for lead_responses:", error.message);
    }
    
    if (global.broadcastLog) {
      global.broadcastLog(`📝 Lead response recorded: "${question}" ➔ "${answer}"`, { type: "system" });
    }
    return { success: true };
  } catch (err) {
    console.error("Failed to save response:", err.message);
    return { error: err.message };
  }
}

module.exports = {
  handleVobizSession,
  vobizCallNumbers
};
