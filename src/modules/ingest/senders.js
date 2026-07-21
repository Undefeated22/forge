// Connect recipes, one per sender. Pure data + one builder: a UI renders this
// as a card/button per vendor and needs to know nothing about Forge.
//
// Two kinds of sender, and the difference is the whole reason this file exists:
//
//   native: true   — the vendor posts its OWN fixed shape and you cannot change
//                    it (Alertmanager, Sentry, PagerDuty, CloudWatch/SNS). Setup
//                    is just URL + credential; normalization is already handled.
//   payloadTemplate — the vendor lets you author the body (Datadog, Splunk,
//                    Honeycomb, New Relic, plain curl). We hand over a template
//                    pre-shaped to hit the aliases in lib/triage.js.
//
// $TOKENS are the vendor's own variable syntax placeholders for a human to
// swap; `senders.test.js` fills them in and runs the result through
// normalizeSignal, so a template here CANNOT silently drift from the aliases
// it is supposed to match.

const SIGNED_HEADERS = {
    "x-grafana-alerting-signature": "<hex HMAC-SHA256 of `<timestamp>:<body>`>",
    "x-grafana-alerting-timestamp": "<unix seconds>",
};

export const SENDERS = Object.freeze([
    {
        id: "grafana",
        label: "Grafana",
        auth: "signature",
        native: true,
        docs: "https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/",
        steps: [
            "Alerting → Contact points → Add contact point → Webhook",
            "Paste the URL below",
            "Set 'Authorization Header' to the key, or configure HMAC signing (12+) with the same key",
        ],
        note: "Grafana 12+ can sign the body. Signing is the stronger path and gives replay protection when the timestamp header is enabled.",
    },
    {
        id: "prometheus",
        label: "Prometheus / Alertmanager",
        auth: "static",
        native: true,
        docs: "https://prometheus.io/docs/alerting/latest/configuration/#webhook_config",
        steps: [
            "Add a webhook_config receiver in alertmanager.yml pointing at the URL",
            "Set http_config.authorization.credentials to the key (sent as Bearer)",
            "Make sure your rules carry a `service` or `job` label — that becomes the incident entity",
        ],
    },
    {
        id: "datadog",
        label: "Datadog",
        auth: "static",
        docs: "https://docs.datadoghq.com/integrations/webhooks/",
        steps: [
            "Integrations → Webhooks → New",
            "Paste the URL, add the key header",
            "Paste the payload template below",
        ],
        payloadTemplate: {
            title: "$EVENT_TITLE",
            body: "$EVENT_MSG",
            alert_type: "$ALERT_TYPE",
            alert_transition: "$ALERT_TRANSITION",
            tags: ["service:$SERVICE"],
        },
    },
    {
        id: "sentry",
        label: "Sentry",
        auth: "static",
        native: true,
        docs: "https://docs.sentry.io/organization/integrations/integration-platform/webhooks/",
        steps: [
            "Settings → Integrations → Create New Integration → Internal",
            "Set the Webhook URL, enable the 'issue' and 'error' resources",
            "Send the key as a Bearer token",
        ],
        note: "The project slug becomes the incident entity.",
    },
    {
        id: "pagerduty",
        label: "PagerDuty",
        auth: "static",
        native: true,
        docs: "https://developer.pagerduty.com/docs/webhooks-overview",
        steps: [
            "Integrations → Generic Webhooks (v3) → New Webhook",
            "Paste the URL, add the key header",
            "Subscribe to incident.triggered and incident.resolved",
        ],
        note: "The PagerDuty service name becomes the incident entity.",
    },
    {
        id: "opsgenie",
        label: "Opsgenie",
        auth: "static",
        native: true,
        docs: "https://support.atlassian.com/opsgenie/docs/integrate-opsgenie-with-webhook/",
        steps: [
            "Settings → Integrations → Webhook",
            "Paste the URL and add the key header",
        ],
        note: "Set the alert's `entity` field; priority P1–P4 maps onto Forge severity.",
    },
    {
        id: "newrelic",
        label: "New Relic",
        auth: "static",
        docs: "https://docs.newrelic.com/docs/alerts/get-notified/intro-notifications/",
        steps: [
            "Alerts → Destinations → Webhook",
            "Paste the URL, add the key header",
            "Use the payload template below in the workflow",
        ],
        payloadTemplate: {
            condition_name: "$CONDITION_NAME",
            severity: "$PRIORITY",
            targets: [{ name: "$SERVICE" }],
        },
    },
    {
        id: "cloudwatch",
        label: "AWS CloudWatch",
        auth: "static",
        native: true,
        docs: "https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/US_SetupSNS.html",
        steps: [
            "Create an SNS topic and subscribe an HTTPS endpoint to the URL",
            "Add the key via an SNS delivery policy header, or use an API Gateway/Lambda shim",
            "Point your alarm's action at the topic",
        ],
        note: "SNS wraps the alarm as a JSON string in `Message`; Forge unwraps it. The alarm's first dimension value (e.g. InstanceId) becomes the entity.",
    },
    {
        id: "splunk",
        label: "Splunk",
        auth: "static",
        docs: "https://docs.splunk.com/Documentation/Splunk/latest/Alert/Webhooks",
        steps: [
            "Save the search as an alert → Add Actions → Webhook",
            "Paste the URL (add the key header via a custom alert action)",
        ],
        payloadTemplate: {
            search_name: "$SEARCH_NAME",
            result: { host: "$SERVICE" },
        },
    },
    {
        id: "honeycomb",
        label: "Honeycomb",
        auth: "static",
        docs: "https://docs.honeycomb.io/notify/alert/webhooks/",
        steps: [
            "Triggers → your trigger → Recipients → Webhook",
            "Paste the URL and add the key header",
        ],
        payloadTemplate: {
            dataset: "$SERVICE",
            name: "$TRIGGER_NAME",
            severity: "$SEVERITY",
        },
    },
    {
        id: "generic",
        label: "Anything else (curl / custom)",
        auth: "static",
        docs: null,
        steps: [
            "POST JSON to the URL with the key header",
            "Include a service/host/entity field — without one Forge replies 422 rather than guess",
        ],
        payloadTemplate: {
            service: "$SERVICE",
            severity: "$SEVERITY",
            title: "$TITLE",
            message: "$MESSAGE",
            status: "firing",
        },
    },
]);

/**
 * Bind the static catalog to one org's live URL and key.
 * The catalog itself stays credential-free so it is safe to import anywhere.
 */
export function buildSetup(sender, { url, key }) {
    return {
        ...sender,
        url,
        headers: sender.auth === "signature"
            ? { ...SIGNED_HEADERS, "//": "or fall back to the static header below" , "x-forge-ingest-key": key }
            : { "x-forge-ingest-key": key },
        curl: `curl -X POST ${url} \\\n  -H 'content-type: application/json' \\\n  -H 'x-forge-ingest-key: ${key}' \\\n  -d '${JSON.stringify(sender.payloadTemplate ?? { service: "checkout", severity: "critical", title: "test" })}'`,
    };
}
