export async function dispatchToSlack(incidentId, aiPayload, escalation) {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;

    if (!webhookUrl) {
        console.log("[Slack] No SLACK_WEBHOOK_URL configured — skipping dispatch");
        return { dispatched: false, reason: "no-webhook-configured" };
    }

    const fp = aiPayload?.incidentFingerprint ?? {};
    const rca = aiPayload?.rootCauseAnalysis ?? {};
    const firstAction = aiPayload?.actionableRunbook?.mitigationSteps?.[0]?.action ?? "No action available";

    const message = {
        blocks: [
            {
                type: "header",
                text: { type: "plain_text", text: `🔥 Forge RCA — ${fp.severityLevel ?? "UNKNOWN"}` }
            },
            {
                type: "section",
                fields: [
                    { type: "mrkdwn", text: `*Primary Component:*\n${fp.primaryFailingComponent ?? "unknown"}` },
                    { type: "mrkdwn", text: `*Confidence:*\n${escalation.score}/100 (${escalation.tier})` }
                ]
            },
            {
                type: "section",
                text: { type: "mrkdwn", text: `*Root Cause:*\n${rca.definitiveRootCause ?? "unknown"}` }
            },
            {
                type: "section",
                text: { type: "mrkdwn", text: `*Recommended First Action:*\n${firstAction}` }
            }
        ]
    };

    if (fp.historicalCorrelation && !fp.historicalCorrelation.startsWith("First occurrence")) {
        message.blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: `*⚠️ Recurring Pattern:*\n${fp.historicalCorrelation}` }
        });
    }

    message.blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: `Incident \`${incidentId}\` · auto-dispatched by Forge` }]
    });

    try {
        const res = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message),
            signal: AbortSignal.timeout(10_000)
        });

        if (!res.ok) {
            console.error(`[Slack] Dispatch failed: ${res.status} ${res.statusText}`);
            return { dispatched: false, reason: `http-${res.status}` };
        }

        console.log(`[Slack] RCA dispatched for incident ${incidentId}`);
        return { dispatched: true };

    } catch (error) {
        console.error("[Slack] Dispatch error:", error.message);
        return { dispatched: false, reason: error.message };
    }
}