// Minimal outbound email. Uses the Resend HTTP API when RESEND_API_KEY is set;
// otherwise logs the link in non-production so local flows stay testable.
// In production with no provider configured we log a WARNING (not the link —
// auth links in a prod log drain are an account-takeover vector).

const isProd = process.env.NODE_ENV === "production";

export async function sendEmail(log, { to, subject, html, actionLink }) {
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey) {
        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                from: process.env.EMAIL_FROM || "Forge <onboarding@resend.dev>",
                to: [to],
                subject,
                html,
            }),
        });
        if (!res.ok) {
            const body = await res.text();
            log.error({ status: res.status, body }, "email send failed");
            throw new Error("Email delivery failed");
        }
        return;
    }

    if (!isProd) {
        log.info(`[EMAIL:dev] to=${to} subject="${subject}" link=${actionLink}`);
        console.log(`\n📧 ${subject} → ${to}\n${actionLink}\n`);
    } else {
        log.warn(`RESEND_API_KEY not set — could not send "${subject}" to ${to}`);
    }
}