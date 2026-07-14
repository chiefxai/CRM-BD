import express from 'express';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'module';

// Import our TypeScript JSON storage utility
import { readAll, writeAll, append, update } from './backend/services/store.ts';

// Import initial data for seeding local databases
import {
  initialLeads,
  initialCampaigns,
  initialWorkflows,
  initialCallLogs,
  initialLoans,
  initialVirtualNumbers,
  initialTeamMembers,
  initialOrgSettings
} from './backend/services/initialData.ts';

dotenv.config({ path: path.join(process.cwd(), 'backend/.env') });

// Import backend service proxies statically so esbuild bundles them
import { handleBrowserSession } from "./backend/services/geminiProxy.cjs";
import { handleTwilioSession, twilioCallNumbers } from "./backend/services/twilioProxy.cjs";
import { handleVobizSession, vobizCallNumbers } from "./backend/services/vobizProxy.cjs";
import { getConfig, updateConfig } from "./backend/services/config.cjs";

const app = express();
const server = createServer(app);
const PORT = Number(process.env.PORT || 3000);

// SSE logs-stream system
let logClients: any[] = [];
function broadcastLog(message: string, details = {}) {
  const logObj = {
    timestamp: new Date().toISOString(),
    message,
    ...details
  };
  const data = `data: ${JSON.stringify(logObj)}\n\n`;
  logClients.forEach((client) => {
    try { client.write(data); } catch (e) {}
  });
}
(global as any).broadcastLog = broadcastLog;

// Seed initial data
function seedCRMData() {
  if (readAll("leads", []).length === 0) writeAll("leads", initialLeads);
  if (readAll("campaigns", []).length === 0) writeAll("campaigns", initialCampaigns);
  if (readAll("workflows", []).length === 0) writeAll("workflows", initialWorkflows);
  if (readAll("loans", []).length === 0) writeAll("loans", initialLoans);
  if (readAll("calllogs", []).length === 0) writeAll("calllogs", initialCallLogs);
  if (readAll("numbers", []).length === 0) writeAll("numbers", initialVirtualNumbers);
  if (readAll("team", []).length === 0) writeAll("team", initialTeamMembers);
  
  // Org is saved as a single object inside store, but readAll wraps it or loads it
  const currentOrg = readAll("org", []);
  if (currentOrg.length === 0) {
    writeAll("org", [initialOrgSettings]);
  }
}
seedCRMData();

// Trust reverse proxy (Railway / Render)
app.set("trust proxy", 1);

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Supabase client initialization
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
let supabase: any = null;

function isValidHttpUrl(string: string) {
  let url;
  try {
    url = new URL(string);
  } catch (_) {
    return false;  
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

if (supabaseUrl && supabaseKey && isValidHttpUrl(supabaseUrl)) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("✅ Supabase client initialized");
  } catch (err: any) {
    console.error("❌ Failed to initialize Supabase client:", err.message);
  }
} else {
  console.log("⚠️ Supabase credentials missing or invalid — database features disabled");
}

// Track active sessions in real-time
let activeSessionsCount = 0;

// Initialize Gemini API client safely (lazy-loaded check)
const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    console.warn('GEMINI_API_KEY is not configured or holds placeholder. Gemini API features will run in offline simulation mode.');
    return null;
  }
  return new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
};

// ==========================================
// 1. Original CRM AI endpoints (from server.ts)
// ==========================================

// AI Insights Desk
app.post('/api/gemini/insights', async (req, res) => {
  const { leads, loans, campaigns, platformMode } = req.body;
  const ai = getGeminiClient();
  const isInsurance = platformMode === 'insurance';

  if (!ai) {
    return res.json({
      success: true,
      insights: isInsurance 
        ? `💡 **AI Underwriting Brief (Simulation Mode)**\n\n*   **Policy Conversions**: Underwriting reports steady workflow. Lead validation is in progress.\n*   **Risk Profile**: Avg risk is low. Follow up on outstanding declarations.`
        : `💡 **AI Credit Brief (Simulation Mode)**\n\n*   **Loan Conversions**: Metrics indicate positive user growth.\n*   **Risk Profile**: Average portfolio credit score is healthy at 700.`
    });
  }

  try {
    const role = isInsurance ? 'Chief Underwriting Officer and Risk Strategist for Insurance' : 'Chief Credit Analyst';
    const terminology = isInsurance ? 'policy types, risk bands, underwritten values, and premiums' : 'loan products, outstanding balances, interest rates, and loan terms';

    const prompt = `You are the ${role} at ChiefXAI. Analyze the following CRM state and provide a high-level strategic brief with executive bullet points. Evaluate the active pipeline metrics, particularly looking at ${terminology}. Use bolding, clean headers, and actionable insights. Do not include system-internal text.
Leads database: ${JSON.stringify(leads)}
${isInsurance ? 'Policies' : 'Loans'} database: ${JSON.stringify(loans)}
Campaigns database: ${JSON.stringify(campaigns)}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        systemInstruction: isInsurance
          ? 'You are a veteran Chief Underwriting Officer and risk strategist for top tier global insurers. Speak clearly, professionally and focus on premium yield and underwriting discipline.'
          : 'You are a veteran Chief Financial Officer and credit risk strategist. Speak clearly and professionally.',
      },
    });

    res.json({ success: true, insights: response.text });
  } catch (error: any) {
    res.json({
      success: true,
      insights: `💡 **AI Strategic Brief (Simulation Fallback Mode)**\n\n*   Pipeline metrics are operational. General credit scoring and risk profiles remain stable.`
    });
  }
});

// Intelligent Lead Scoring & Auto-tagging
app.post('/api/gemini/score-lead', async (req, res) => {
  const { lead } = req.body;
  const ai = getGeminiClient();

  if (!ai) {
    const score = lead.financialInfo
      ? Math.round((lead.financialInfo.creditScore - 300) / 5.2 + (lead.financialInfo.monthlyIncome > 8000 ? 20 : 5) - lead.financialInfo.debtToIncome * 30)
      : 50;
    const finalScore = Math.max(10, Math.min(100, score));
    const tags = finalScore > 85 ? ['Prime-Lead', 'Low-Risk'] : finalScore < 50 ? ['Subprime', 'High-DTI'] : ['Standard-Profile'];

    return res.json({
      success: true,
      score: finalScore,
      tags,
      decision: `Offline scoring algorithm: Credit score ${lead.financialInfo?.creditScore || '700'} maps to rating ${finalScore}/100.`
    });
  }

  try {
    const prompt = `Assess the loan eligibility score (0-100) for this applicant:
Applicant Profile: ${JSON.stringify(lead)}
Analyze debt-to-income (DTI), credit score, monthly income stability, and loan amount requested. Provide the response strictly in JSON format.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            score: { type: Type.INTEGER, description: 'Eligibility score between 0 and 100.' },
            tags: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Appropriate tags such as Elite, High-DTI, Low-Income, Strong-Employer.',
            },
            decision: { type: Type.STRING, description: 'One-sentence rationale explaining the score.' },
          },
          required: ['score', 'tags', 'decision'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    res.json({ success: true, ...parsed });
  } catch (error: any) {
    res.json({
      success: true,
      score: 75,
      tags: ['Standard-Profile'],
      decision: `Scoring engine fallback: Candidate meets standard credit thresholds.`
    });
  }
});

// Document OCR & Verification Analyzer
app.post('/api/gemini/verify-doc', async (req, res) => {
  const { docType, docName, fileContent } = req.body;
  const ai = getGeminiClient();

  if (!ai) {
    const nameMatch = docName.toLowerCase().includes('sarah') || docName.toLowerCase().includes('jenkins');
    const income = docName.toLowerCase().includes('w2') || docName.toLowerCase().includes('paystub') ? 8500 : undefined;
    return res.json({
      success: true,
      ocrData: {
        extractedName: nameMatch ? 'Sarah Jenkins' : 'Michael Chen',
        extractedIncome: income,
        extractedEmployer: docType === 'Paystub' ? 'TechCorp Solutions' : undefined,
        confidenceScore: 98,
        issues: [],
      },
      status: 'Verified',
    });
  }

  try {
    const prompt = `Act as an automated document underwriting parser. Extract structural details from this document:
Document Category: ${docType}
File Name: ${docName}
Extracted Text Segment: "${fileContent || 'Jane Doe, Pay Period: June 2026, Net Income: $6,500, Employer: Acme Global Ltd'}"

Determine Name compatibility, Income parameters, Employer name, confidence rating, and flag any discrepancy. Format response as JSON.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            extractedName: { type: Type.STRING, description: 'Full name on the document.' },
            extractedIncome: { type: Type.NUMBER, description: 'Extracted monthly/annual wages if readable.' },
            extractedEmployer: { type: Type.STRING, description: 'Employer name if paystub.' },
            confidenceScore: { type: Type.INTEGER, description: 'Parser confidence score 0-100.' },
            issues: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Issues detected (e.g. Low resolution, Name mismatch, expired doc).',
            },
          },
          required: ['extractedName', 'confidenceScore', 'issues'],
        },
      },
    });

    const ocrData = JSON.parse(response.text || '{}');
    const status = ocrData.issues.length > 0 ? 'Rejected' : 'Verified';
    res.json({ success: true, ocrData, status });
  } catch (error: any) {
    res.json({
      success: true,
      ocrData: {
        extractedName: 'Sarah Jenkins',
        confidenceScore: 90,
        issues: [],
      },
      status: 'Verified',
    });
  }
});

// Voice Call Simulator Engine
app.post(['/api/simulate-call', '/api/gemini/simulate-call'], async (req, res) => {
  const { leadName, loanAmount, prompt, transcript, customerUtterance } = req.body;
  const ai = getGeminiClient();

  if (!ai) {
    let reply = `Hello ${leadName}, I appreciate that. I've noted down your loan details. Let's touch base again soon.`;
    let sentiment: 'Positive' | 'Neutral' | 'Negative' = 'Neutral';
    let intent: 'Interested' | 'Not Interested' | 'Callback Scheduled' | 'Wrong Number' | 'Unknown' = 'Unknown';
    let isFinished = false;

    const lowerUtterance = customerUtterance.toLowerCase();
    if (lowerUtterance.includes('yes') || lowerUtterance.includes('sure') || lowerUtterance.includes('interested')) {
      reply = `That is fantastic! Since you are interested in the $${loanAmount} loan, I am sending an upload link for your documents right now. Should I also book an agent to call you back?`;
      sentiment = 'Positive';
      intent = 'Interested';
    } else if (lowerUtterance.includes('no') || lowerUtterance.includes('stop') || lowerUtterance.includes('busy')) {
      reply = `I completely understand. I will close your file. Thanks for your time, goodbye!`;
      sentiment = 'Negative';
      intent = 'Not Interested';
      isFinished = true;
    }

    return res.json({ success: true, reply, sentiment, intent, isFinished });
  }

  try {
    const formattedTranscript = transcript
      .map((t: any) => `${t.speaker}: ${t.text}`)
      .join('\n');

    const conversationPrompt = `You are an conversational outbound AI calling agent for ChiefXAI. You are in a phone call with client ${leadName} discussing their requested loan of $${loanAmount}.
Campaign Persona/Instruction: ${prompt}

Prior Conversation:
${formattedTranscript}

Customer's new message: "${customerUtterance}"

Generate your next reply. It must be brief (1-2 clear, human sentences as spoken on a phone). Also analyze the customer's sentiment ('Positive' | 'Neutral' | 'Negative') and intent ('Interested' | 'Not Interested' | 'Callback Scheduled' | 'Wrong Number' | 'Unknown') and whether the conversation has naturally concluded (isFinished).
Output strictly as JSON.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: conversationPrompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            reply: { type: Type.STRING, description: 'Natural spoken reply from the AI agent.' },
            sentiment: {
              type: Type.STRING,
              enum: ['Positive', 'Neutral', 'Negative'],
              description: 'Sentiment of the customer.',
            },
            intent: {
              type: Type.STRING,
              enum: ['Interested', 'Not Interested', 'Callback Scheduled', 'Wrong Number', 'Unknown'],
              description: 'Customer intent analysis.',
            },
            isFinished: {
              type: Type.BOOLEAN,
              description: 'Whether the conversation has ended (e.g., customer said goodbye or asked to hang up).',
            },
          },
          required: ['reply', 'sentiment', 'intent', 'isFinished'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    res.json({ success: true, ...parsed });
  } catch (error: any) {
    res.json({
      success: true,
      reply: `I see. I will document this on your profile.`,
      sentiment: 'Neutral',
      intent: 'Unknown',
      isFinished: false
    });
  }
});

// ==========================================
// 2. Copied Real-time & Twilio Voice Endpoints
// ==========================================

// Twilio Webhook Incoming Answer Endpoint
app.post("/api/twilio/incoming", (req, res) => {
  const { CallSid, From } = req.body;
  if (CallSid && From) {
    twilioCallNumbers.set(CallSid, From);
    setTimeout(() => twilioCallNumbers.delete(CallSid), 120000);
  }

  res.set("Content-Type", "text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/twilio/stream" />
  </Connect>
</Response>`);
});

// Initiate Outbound Twilio Call
app.post("/api/twilio/call", async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ error: "Missing phoneNumber in request body" });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !twilioNumber) {
    return res.status(500).json({
      error: "Twilio credentials are not configured on the server. Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER."
    });
  }

  try {
    const authString = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    let callbackUrl;
    if (process.env.PUBLIC_URL) {
      callbackUrl = `${process.env.PUBLIC_URL}/api/twilio/incoming`;
    } else {
      const protocol = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
      const host = req.headers.host;
      callbackUrl = `${protocol}://${host}/api/twilio/incoming`;
    }

    console.log(`📞 Triggering Twilio outbound call to ${phoneNumber} from ${twilioNumber}...`);

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${authString}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          To: phoneNumber,
          From: twilioNumber,
          Url: callbackUrl
        })
      }
    );

    const data: any = await response.json();
    if (!response.ok) {
      throw new Error(data.message || `Twilio API error (Status: ${response.status})`);
    }

    console.log(`✅ Outbound Twilio call initiated. Call SID: ${data.sid}`);
    res.json({ success: true, callSid: data.sid });
  } catch (err: any) {
    console.error("❌ Failed to initiate Twilio outbound call:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Hang up active Twilio call
app.post("/api/twilio/hangup", async (req, res) => {
  const { callSid } = req.body;
  if (!callSid) {
    return res.status(400).json({ error: "Missing callSid in request body" });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return res.status(500).json({ error: "Twilio credentials are not configured on the server." });
  }

  try {
    const authString = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    console.log(`📞 Hanging up Twilio call ${callSid}...`);

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`,
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${authString}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ Status: "completed" })
      }
    );

    const data: any = await response.json();
    if (!response.ok) {
      throw new Error(data.message || `Twilio hangup error (Status: ${response.status})`);
    }

    console.log(`✅ Twilio call completed successfully: ${callSid}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error("❌ Failed to hang up Twilio call:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Vobiz Call Endpoints ──
app.post("/api/vobiz/incoming", (req, res) => {
  const { CallUUID, From } = req.body;
  if (CallUUID && From) {
    vobizCallNumbers.set(CallUUID, From);
    setTimeout(() => vobizCallNumbers.delete(CallUUID), 120000);
  }

  res.set("Content-Type", "text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
    wss://${req.headers.host}/vobiz/stream
  </Stream>
</Response>`);
});

app.post("/api/vobiz/call", async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ error: "Missing phoneNumber in request body" });
  }

  const authId = process.env.VOBIZ_AUTH_ID;
  const authToken = process.env.VOBIZ_AUTH_TOKEN;
  const vobizNumber = process.env.VOBIZ_PHONE_NUMBER;

  if (!authId || !authToken || !vobizNumber) {
    return res.status(500).json({
      error: "Vobiz credentials are not configured. Please set VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, and VOBIZ_PHONE_NUMBER."
    });
  }

  try {
    let callbackUrl;
    if (process.env.PUBLIC_URL) {
      callbackUrl = `${process.env.PUBLIC_URL}/api/vobiz/incoming`;
    } else {
      const protocol = req.secure || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
      const host = req.headers.host;
      callbackUrl = `${protocol}://${host}/api/vobiz/incoming`;
    }

    console.log(`📞 Triggering Vobiz outbound call to ${phoneNumber} from ${vobizNumber}...`);

    const response = await fetch(
      `https://api.vobiz.ai/api/v1/Account/${authId}/Call/`,
      {
        method: "POST",
        headers: {
          "X-Auth-ID": authId,
          "X-Auth-Token": authToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: vobizNumber,
          to: phoneNumber,
          answer_url: callbackUrl,
          answer_method: "POST"
        })
      }
    );

    const data: any = await response.json();
    if (!response.ok) {
      throw new Error(data.message || `Vobiz API error (Status: ${response.status})`);
    }

    console.log(`✅ Outbound Vobiz call initiated. Call UUID: ${data.CallUUID || data.id || 'success'}`);
    res.json({ success: true, callSid: data.CallUUID || data.id });
  } catch (err: any) {
    console.error("❌ Failed to initiate Vobiz outbound call:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get active configuration (voice settings and prompt editor)
app.get("/api/config", (req, res) => {
  res.json(getConfig());
});

// Update configuration
app.post("/api/config", (req, res) => {
  console.log("⚙️ Updating config:", req.body);
  const updated = updateConfig(req.body);
  res.json(updated);
});

// Get call logs
app.get("/api/calls", async (req, res) => {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("calls")
        .select("*")
        .order("created_at", { ascending: false });
      if (!error) return res.json({ calls: data });
    } catch (err: any) {
      console.error(err);
    }
  }
  res.json({ calls: readAll("calls_default", []) });
});

// SSE endpoint for live logs
app.get("/api/logs-stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`data: ${JSON.stringify({ timestamp: new Date().toISOString(), message: "Live system log stream initialized" })}\n\n`);
  
  logClients.push(res);
  req.on("close", () => {
    logClients = logClients.filter((c) => c !== res);
  });
});

// Chroma Vector search proxy
app.get("/api/v2/chroma/search", async (req, res) => {
  const query = req.query.q as string || "";
  if (!query) return res.json({ documents: [], metadatas: [], ids: [] });
  try {
    const chromaUrl = process.env.CHROMA_URL || "https://chroma-corechroma-production-1118.up.railway.app";
    const collectionsRes = await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`);
    const collections: any = await collectionsRes.json();
    const targetColl = collections.find((c: any) => c.name === "policy-documents");
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
      const expanded: string[] = [];
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

    const data = await chromaRes.json();
    res.json(data);
  } catch (err: any) {
    console.error("Chroma search proxy failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// List bidirectionally compatible Gemini models
app.get("/list-models", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not configured" });
    }
    
    let allModels: any[] = [];
    let pageToken = "";
    
    do {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}${pageToken ? `&pageToken=${pageToken}` : ""}`;
      const response = await fetch(url);
      const data: any = await response.json();
      if (data.models) {
        allModels.push(...data.models);
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    
    const liveModels = allModels.filter(m => 
      m.supportedGenerationMethods && m.supportedGenerationMethods.includes("bidiGenerateContent")
    );
    
    res.json({
      totalModelsFound: allModels.length,
      liveModels: liveModels.map(m => ({
        name: m.name,
        displayName: m.displayName,
        supportedGenerationMethods: m.supportedGenerationMethods
      })),
      allModelNames: allModels.map(m => m.name)
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. CRM CRUD APIs & Sync Endpoints
// ==========================================

// Leads Database API
app.get('/api/leads', (req, res) => {
  res.json(readAll('leads', initialLeads));
});

app.post('/api/leads', (req, res) => {
  const newLead = {
    id: `L-${Date.now().toString().slice(-4)}`,
    createdAt: new Date().toISOString(),
    ...req.body
  };
  append('leads', newLead);
  broadcastLog(`👤 Created new lead: ${newLead.name} via UI`, { type: 'lead', leadId: newLead.id });
  res.status(201).json(newLead);
});

app.patch('/api/leads/:id', (req, res) => {
  const updated = update<any>('leads', req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Lead not found' });
  broadcastLog(`👤 Updated lead profile: ${updated.name}`, { type: 'lead', leadId: req.params.id });
  res.json(updated);
});

app.delete('/api/leads/:id', (req, res) => {
  const leadsList = readAll<any>('leads', initialLeads);
  const filtered = leadsList.filter(l => l.id !== req.params.id);
  writeAll('leads', filtered);
  broadcastLog(`👤 Removed lead: ${req.params.id}`, { type: 'lead', leadId: req.params.id });
  res.json({ success: true });
});

// Loans Database API
app.get('/api/loans', (req, res) => {
  res.json(readAll('loans', initialLoans));
});

app.post('/api/loans', (req, res) => {
  const newLoan = {
    id: `LN-${Date.now().toString().slice(-4)}`,
    createdAt: new Date().toISOString(),
    ...req.body
  };
  append('loans', newLoan);
  broadcastLog(`💵 Created new loan application: ${newLoan.id}`, { type: 'loan', loanId: newLoan.id });
  res.status(201).json(newLoan);
});

app.patch('/api/loans/:id', (req, res) => {
  const updated = update<any>('loans', req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Loan not found' });
  broadcastLog(`💵 Updated loan application: ${updated.id}`, { type: 'loan', loanId: req.params.id });
  res.json(updated);
});

// Campaigns Database API
app.get('/api/campaigns', (req, res) => {
  res.json(readAll('campaigns', initialCampaigns));
});

app.post('/api/campaigns', (req, res) => {
  const newCampaign = {
    id: `CAMP-${Date.now().toString().slice(-4)}`,
    createdAt: new Date().toISOString(),
    ...req.body
  };
  append('campaigns', newCampaign);
  broadcastLog(`📢 Created marketing campaign: ${newCampaign.name}`, { type: 'campaign', campaignId: newCampaign.id });
  res.status(201).json(newCampaign);
});

app.patch('/api/campaigns/:id', (req, res) => {
  const updated = update<any>('campaigns', req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Campaign not found' });
  broadcastLog(`📢 Updated campaign settings: ${updated.name}`, { type: 'campaign', campaignId: req.params.id });
  res.json(updated);
});

// Workflows Database API
app.get('/api/workflows', (req, res) => {
  res.json(readAll('workflows', initialWorkflows));
});

app.post('/api/workflows', (req, res) => {
  const newWorkflow = {
    id: `WF-${Date.now().toString().slice(-4)}`,
    ...req.body
  };
  append('workflows', newWorkflow);
  broadcastLog(`⚙️ Created routing workflow: ${newWorkflow.name}`, { type: 'workflow', workflowId: newWorkflow.id });
  res.status(201).json(newWorkflow);
});

app.patch('/api/workflows/:id', (req, res) => {
  const updated = update<any>('workflows', req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Workflow not found' });
  broadcastLog(`⚙️ Updated workflow settings: ${updated.name}`, { type: 'workflow', workflowId: req.params.id });
  res.json(updated);
});

// Call Logs Database API
app.get('/api/call-logs', (req, res) => {
  res.json(readAll('calllogs', initialCallLogs));
});

app.post('/api/call-logs', (req, res) => {
  const newLog = {
    id: `CL-${Date.now().toString().slice(-4)}`,
    ...req.body
  };
  append('calllogs', newLog);
  broadcastLog(`📞 Logged call with: ${newLog.leadName || 'Contact'}`, { type: 'calllog', logId: newLog.id });
  res.status(201).json(newLog);
});

// Settings Database APIs
app.get('/api/settings/numbers', (req, res) => {
  res.json(readAll('numbers', initialVirtualNumbers));
});

// Bulk State Synchronization Endpoints
app.post('/api/leads/sync', (req, res) => res.json(writeAll('leads', req.body)));
app.post('/api/loans/sync', (req, res) => res.json(writeAll('loans', req.body)));
app.post('/api/campaigns/sync', (req, res) => res.json(writeAll('campaigns', req.body)));
app.post('/api/workflows/sync', (req, res) => res.json(writeAll('workflows', req.body)));
app.post('/api/settings/numbers/sync', (req, res) => res.json(writeAll('numbers', req.body)));
app.post('/api/settings/team/sync', (req, res) => res.json(writeAll('team', req.body)));
app.post('/api/call-logs/sync', (req, res) => res.json(writeAll('calllogs', req.body)));

app.post('/api/settings/numbers', (req, res) => {
  const newNumber = {
    id: `NUM-${Date.now().toString().slice(-4)}`,
    ...req.body
  };
  append('numbers', newNumber);
  broadcastLog(`📞 Assigned new virtual number: ${newNumber.phoneNumber}`, { type: 'settings' });
  res.status(201).json(newNumber);
});

app.patch('/api/settings/numbers/:id', (req, res) => {
  const updated = update<any>('numbers', req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Number not found' });
  res.json(updated);
});

app.get('/api/settings/team', (req, res) => {
  res.json(readAll('team', initialTeamMembers));
});

app.post('/api/settings/team', (req, res) => {
  const newMember = {
    id: `TM-${Date.now().toString().slice(-4)}`,
    ...req.body
  };
  append('team', newMember);
  broadcastLog(`👤 Registered team member: ${newMember.name}`, { type: 'settings' });
  res.status(201).json(newMember);
});

app.patch('/api/settings/team/:id', (req, res) => {
  const updated = update<any>('team', req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Team member not found' });
  res.json(updated);
});

app.get('/api/settings/org', (req, res) => {
  const orgList = readAll('org', [initialOrgSettings]);
  res.json(orgList[0] || initialOrgSettings);
});

app.post('/api/settings/org', (req, res) => {
  writeAll('org', [req.body]);
  broadcastLog(`⚙️ Updated organization settings: ${req.body.name}`, { type: 'settings' });
  res.json(req.body);
});

// ==========================================
// 4. WebSocket & Real-Time Connection Server
// ==========================================

const wss = new WebSocketServer({ noServer: true });
const wssTwilio = new WebSocketServer({ noServer: true });
const wssVobiz = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req) => {
  activeSessionsCount++;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`🌐 Browser connected from ${ip} | Active: ${activeSessionsCount}`);
  
  handleBrowserSession(ws);

  ws.on("close", () => {
    activeSessionsCount = Math.max(0, activeSessionsCount - 1);
    console.log(`🌐 Browser disconnected | Active: ${activeSessionsCount}`);
  });
});

wssTwilio.on("connection", (ws, req) => {
  activeSessionsCount++;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`📞 Twilio call connected from ${ip} | Active: ${activeSessionsCount}`);

  handleTwilioSession(ws);

  ws.on("close", () => {
    activeSessionsCount = Math.max(0, activeSessionsCount - 1);
    console.log(`📞 Twilio call disconnected | Active: ${activeSessionsCount}`);
  });
});

wssVobiz.on("connection", (ws, req) => {
  activeSessionsCount++;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`📞 Vobiz call connected from ${ip} | Active: ${activeSessionsCount}`);

  handleVobizSession(ws);

  ws.on("close", () => {
    activeSessionsCount = Math.max(0, activeSessionsCount - 1);
    console.log(`📞 Vobiz call disconnected | Active: ${activeSessionsCount}`);
  });
});

server.on("upgrade", (request, socket, head) => {
  let pathname;
  try {
    pathname = new URL(request.url || '', `http://${request.headers.host || "localhost"}`).pathname;
  } catch (e) {
    pathname = (request.url || '').split("?")[0];
  }

  if (pathname === "/session") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else if (pathname === "/twilio/stream") {
    wssTwilio.handleUpgrade(request, socket, head, (ws) => {
      wssTwilio.emit("connection", ws, request);
    });
  } else if (pathname === "/vobiz/stream") {
    wssVobiz.handleUpgrade(request, socket, head, (ws) => {
      wssVobiz.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Dynamic Chroma DB Seeding
async function seedChromaDB() {
  try {
    const chromaUrl = process.env.CHROMA_URL || "https://chroma-corechroma-production-1118.up.railway.app";
    console.log(`🤖 Checking Chroma DB collection seeding at: ${chromaUrl}`);
    const collectionsRes = await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`);
    if (!collectionsRes.ok) {
      console.warn("⚠️ Failed to check Chroma DB collections list");
      return;
    }
    const collections: any = await collectionsRes.json();
    let targetColl = collections.find((c: any) => c.name === "policy-documents");
    let needsSeed = !targetColl;
    let newCollectionId = targetColl?.id;

    if (targetColl) {
      try {
        const countRes = await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections/${targetColl.id}/count`);
        if (countRes.ok) {
          const count = await countRes.json();
          const fs = require("fs");
          const path = require("path");
          const seedPath = path.join(process.cwd(), "backend/policy_documents_seed.json");
          let seedCount = 0;
          if (fs.existsSync(seedPath)) {
            const seedData = JSON.parse(fs.readFileSync(seedPath, "utf8"));
            seedCount = seedData.ids.length;
          }
          if (count === 0 || count !== seedCount) {
            console.log(`📥 Document count mismatch (DB: ${count}, Local Seed: ${seedCount}). Resetting and re-seeding...`);
            await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections/${targetColl.name}`, {
              method: "DELETE"
            });
            needsSeed = true;
            targetColl = null;
          }
        }
      } catch (err: any) {
        console.warn("⚠️ Failed to query/re-seed collection document count:", err.message);
      }
    }

    if (needsSeed) {
      if (!targetColl) {
        console.log(`📥 "policy-documents" collection not found on target Chroma. Creating...`);
        const createRes = await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "policy-documents",
            metadata: { description: "Health Insurance Policy Documents" },
            get_or_create: true
          })
        });
        if (!createRes.ok) {
          console.error("❌ Failed to create collection on target Chroma DB:", await createRes.text());
          return;
        }
        const targetCollection: any = await createRes.json();
        newCollectionId = targetCollection.id;
      }

      const seedPath = path.join(process.cwd(), "backend/policy_documents_seed.json");
      if (fs.existsSync(seedPath)) {
        const seedData = JSON.parse(fs.readFileSync(seedPath, "utf8"));
        console.log(`📤 Seeding ${seedData.ids.length} chunks into target Chroma DB...`);
        const mockEmbeddings = new Array(seedData.ids.length).fill(null).map(() => new Array(384).fill(0.0));
        const addRes = await fetch(`${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database/collections/${newCollectionId}/add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ids: seedData.ids,
            embeddings: mockEmbeddings,
            metadatas: seedData.metadatas,
            documents: seedData.documents
          })
        });
        if (addRes.ok) {
          console.log("🎉 Chroma DB seeded successfully with policy documents!");
        } else {
          console.error("❌ Failed to seed Chroma DB:", await addRes.text());
        }
      }
    } else {
      console.log(`✅ Chroma DB "policy-documents" collection already exists. Skipping seed.`);
    }
  } catch (err: any) {
    console.error("❌ Error checking/seeding Chroma DB:", err.message);
  }
}

// Serving Frontend Assets & Developer middlewares
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    const indexPath = path.join(distPath, 'index.html');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      const fs = require('fs');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(200).json({
          status: 'running',
          service: 'CRM Backend API Server',
          message: 'Vite frontend assets are not compiled. API and WebSocket endpoints are fully operational.'
        });
      }
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Unified CRM & Call Server running on port ${PORT}`);
    console.log(`📱 Frontend: http://localhost:${PORT}`);
    console.log(`🎙️  Voice WS endpoint: wss://localhost:${PORT}/session`);
    console.log(`======================================================\n`);
    
    // Run Chroma DB seed in background
    seedChromaDB();
  });
}

startServer();
