import { eq } from "drizzle-orm";
import { evidence } from "../../db/schema.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { fuseLogs } from "./logFusion.js";
import { getBestGraphContext, formatGraphContextForPrompt } from "./graphReader.js";

if (!process.env.GEMINI_API_KEY) {
    throw new Error("Missing required environment variable: GEMINI_API_KEY");
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
export async function analyzeEvidence(db, incidentId, tenantId = "default") {

    const records = await db
        .select()
        .from(evidence)
        .where(eq(evidence.incidentId, incidentId));

    if (!records.length) return null;

    const { fused, lineCount, sourceCount } = fuseLogs(records);

const graphContext = await getBestGraphContext(db, fused, tenantId);
const historicalMemory = formatGraphContextForPrompt(graphContext);
    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        generationConfig: { responseMimeType: "application/json" }
    });

    const prompt = `
You are the Forge Master Diagnostic Agent, an elite AI system designed to analyze highly complex, distributed system failures. You operate with the rigor of a Principal Systems Architect.

Your mandate is to ingest system telemetry, perform a deterministic Root Cause Analysis (RCA), and output structured intelligence. You must absolutely NOT hallucinate or guess.

${historicalMemory ? `${historicalMemory}\n\nIMPORTANT: The above is REAL historical data from previous incidents in this exact system. You MUST acknowledge whether the current incident matches this known pattern in your "historicalCorrelation" field below.\n` : ""}
TELEMETRY METADATA:
- Sources fused: ${sourceCount} log file(s)
- Total lines analyzed: ${lineCount}
- Format: [source-file] timestamp | log line

EXECUTION PROTOCOL:
1. TOPOLOGY MAPPING: Identify the components involved (e.g., API Gateway -> Auth Service -> Postgres).
2. CHAIN OF THOUGHT: Explicitly write out your step-by-step logical deduction in "diagnosticReasoning" BEFORE declaring a root cause.
3. FALSIFICATION: For every hypothesis, attempt to disprove it using available evidence.
4. EVIDENCE BINDING: Every final claim MUST cite the exact log line, timestamp, or trace ID.
${historicalMemory ? "5. MEMORY VALIDATION: Cross-reference your findings against the Forge Historical Memory above. If your root cause matches the historical pattern, explicitly state this in your executiveSummary." : ""}

Return EXACTLY this JSON structure. Do not include markdown formatting like \`\`\`json.

{
  "timeline": [
    { "time": "...", "event": "..." }
  ],
  "diagnosticReasoning": [
    {
      "step": 1,
      "focus": "Identifying the initial anomaly",
      "observation": "What the raw data shows at the start of the incident",
      "deduction": "What this implies technically"
    },
    {
      "step": 2,
      "focus": "Tracing the cascade",
      "observation": "How the initial anomaly impacted downstream systems",
      "deduction": "The mechanism of failure"
    },
    {
      "step": 3,
      "focus": "Falsification check",
      "observation": "Testing the most obvious hypothesis",
      "deduction": "Why the obvious answer might be wrong based on the logs"
    }
  ],
 "incidentFingerprint": {
    "executiveSummary": "A highly technical, 2-sentence summary of the definitive failure state.",
    "primaryFailingComponent": "The exact microservice, database, or network layer that broke first.",
    "severityLevel": "SEV-1 | SEV-2 | SEV-3",
    "historicalCorrelation": "If Forge Historical Memory was provided above, state whether this incident matches a known recurring pattern and how many times it has occurred. If no history was provided, state 'First occurrence — no historical pattern on record.'"
  },
  "rootCauseAnalysis": {
    "definitiveRootCause": "The absolute lowest-level technical trigger.",
    "evidenceCitations": [
      "EXACT copy-pasted log line that proves the root cause."
    ]
  },
  "actionableRunbook": {
    "mitigationSteps": [
      {
        "action": "Precise description of the fix",
        "cliCommand": "Copy-pasteable CLI command if applicable",
        "riskAssessment": "What could break if an engineer runs this?"
      }
    ]
  },
  "confidenceMatrix": {
    "overallScore": 0,
    "missingTelemetry": [
      "Specifically what metrics or logs are missing that would increase confidence to 100%"
    ]
  }
}

FUSED TELEMETRY TIMELINE (${sourceCount} source(s), ${lineCount} lines):
${fused}
    `;

 const responseText = await callWithRetry(model, prompt);
return JSON.parse(responseText);}

const GEMINI_TIMEOUT_MS = 60_000;

async function callWithRetry(model, prompt, maxRetries = 4) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await model.generateContent(prompt, { timeout: GEMINI_TIMEOUT_MS });
            return result.response.text();
        } catch (error) {
            const msg = error.message ?? "";
            const isRetryable =
                msg.includes("503") ||
                msg.includes("high demand") ||
                msg.includes("fetch failed") ||
                msg.includes("ECONNRESET") ||
                msg.includes("ETIMEDOUT") ||
                msg.includes("aborted") ||
                msg.includes("network");

            if (!isRetryable || attempt === maxRetries) throw error;

            const waitMs = 5000 * attempt;
            console.log(`[Analysis] Transient error (${msg.slice(0, 40)}) — attempt ${attempt}/${maxRetries}, retrying in ${waitMs / 1000}s...`);
            await new Promise(r => setTimeout(r, waitMs));
        }
    }
}