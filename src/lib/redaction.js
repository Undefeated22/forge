// Reversible secret/PII redaction for logs, applied at ingest BEFORE anything is
// stored in Postgres or sent to the LLM. Detected values are replaced with
// STABLE placeholders — the same secret always maps to the same «TYPE_N» token
// within a document — so the model can still reason about structure ("«IP_1»
// called «IP_2»", "the same «AWS_KEY_1» appears in both files") without ever
// seeing the raw value. The placeholder↔value map is stored encrypted elsewhere
// (redactionCrypto.js) so an authorized engineer can re-hydrate on display.
//
// Guillemet delimiters (« ») are used because they essentially never appear in
// real logs, so a placeholder can't collide with log text on re-hydration.

// Luhn check keeps the card detector from redacting long numeric IDs.
function luhnValid(digits) {
    const s = digits.replace(/[^0-9]/g, "");
    if (s.length < 13 || s.length > 19) return false;
    let sum = 0, alt = false;
    for (let i = s.length - 1; i >= 0; i--) {
        let d = s.charCodeAt(i) - 48;
        if (alt) { d *= 2; if (d > 9) d -= 9; }
        sum += d; alt = !alt;
    }
    return sum % 10 === 0;
}

// Ordered most-specific → most-general. Every pattern captures a named group
// `val` — only that span is replaced, so surrounding context ("password=") is
// preserved. `d` (hasIndices) lets us get the group's exact offsets.
const DETECTORS = [
    { type: "PRIVATE_KEY", re: /(?<val>-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)/g },
    { type: "JWT", re: /(?<val>eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})/g },
    { type: "AWS_KEY", re: /(?<val>(?:AKIA|ASIA)[0-9A-Z]{16})/g },
    { type: "GITHUB_TOKEN", re: /(?<val>gh[pousr]_[A-Za-z0-9]{20,})/g },

    // --- Provider credentials, matched on their issuer prefix ---
    //
    // These exist because the keyed-secret rule below only fires when a token
    // appears next to a recognisable key NAME. A token can just as easily show
    // up bare — inside a URL, a stack frame, a curl line echoed into a log — and
    // then there is no "key=" for the generic rule to anchor on. Every prefix
    // here is issuer-assigned and does not occur in ordinary prose, so matching
    // on the prefix alone carries no realistic false-positive cost.
    //
    // Distinct types rather than one PROVIDER_KEY bucket: during an incident the
    // first question is "which credential do I rotate", and the placeholder is
    // what an engineer sees before deciding to re-hydrate.
    { type: "STRIPE_KEY", re: /\b(?<val>(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})/g },
    { type: "SLACK_TOKEN", re: /\b(?<val>xox[abeprs]-[A-Za-z0-9-]{10,})/g },
    // A webhook URL IS the credential — anyone holding it can post as the app.
    { type: "SLACK_WEBHOOK", re: /(?<val>https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\/+-]{20,})/g },
    { type: "GOOGLE_API_KEY", re: /\b(?<val>AIza[0-9A-Za-z_-]{35})\b/g },
    // Covers OpenAI (sk-, sk-proj-, sk-svcacct-) and Anthropic (sk-ant-). The
    // underscore forms above are Stripe's and are matched separately.
    { type: "LLM_API_KEY", re: /\b(?<val>sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,})/g },
    { type: "GITLAB_TOKEN", re: /\b(?<val>glpat-[A-Za-z0-9_-]{20,})/g },
    { type: "NPM_TOKEN", re: /\b(?<val>npm_[A-Za-z0-9]{36})\b/g },
    { type: "SENDGRID_KEY", re: /\b(?<val>SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g },
    { type: "RESEND_KEY", re: /\b(?<val>re_[A-Za-z0-9_]{16,})\b/g },

    { type: "BEARER", re: /[Bb]earer\s+(?<val>[A-Za-z0-9\-._~+/]{10,}=*)/g },
    { type: "PASSWORD", re: /:\/\/[^:/@\s]+:(?<val>[^@\s/]+)@/g }, // connection-string password

    // Keyed secrets. The `<PREFIX>_` group is what generalises this beyond the
    // providers enumerated above: STRIPE_KEY, DATADOG_TOKEN, ACME_SECRET and any
    // other `<SOMETHING>_KEY=` an unknown vendor invents all match, so a new
    // provider does not need a new pattern to be covered.
    //
    // The leading \b is load-bearing: without it the bare `key` alternative
    // matches inside ordinary words ("monkey=..." would redact), because the
    // engine retries at every offset. With it, `key` must start a word or follow
    // a `_`/`-` separator.
    //
    // Over-redaction is the deliberate direction here — `primary_key=1234` gets
    // tokenized. At a trust boundary a false positive costs a placeholder in a
    // log; a false negative costs a live credential sent to a third party. The
    // original is recoverable through rehydrate() either way.
    // `*` not `?` on the prefix group: names stack more than one segment deep
    // (DATADOG_API_KEY is PREFIX_PREFIX_KEYWORD), and allowing only one segment
    // silently missed exactly that shape.
    { type: "SECRET", re: /\b(?:(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|key|credential|passphrase)|apikey|auth(?:orization)?)["']?\s*[:=]\s*["']?(?<val>[A-Za-z0-9\-_./+=]{8,})/gi },
    { type: "EMAIL", re: /(?<val>[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g },
    { type: "SSN", re: /\b(?<val>\d{3}-\d{2}-\d{4})\b/g },
    { type: "CARD", re: /\b(?<val>(?:\d[ -]?){13,19})\b/g, validate: (v) => luhnValid(v) },
    { type: "IP", re: /\b(?<val>(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d))\b/g },
];

function looksLikePlaceholder(v) {
    return /^«[A-Z_]+_\d+»$/.test(v);
}

/**
 * A stateful redactor. Call redact() over one or many texts (e.g. each evidence
 * file in an incident) to get consistent placeholders across all of them; read
 * `.mappings` afterwards to persist the reverse map.
 */
export function createRedactor(seed = []) {
    const valueToPlaceholder = new Map();
    const counters = Object.create(null);
    const mappings = [];

    // Seed with an existing map (value→placeholder) so re-uploads reuse tokens.
    for (const m of seed) {
        valueToPlaceholder.set(m.value, m.placeholder);
        const n = Number(m.placeholder.match(/_(\d+)»$/)?.[1] ?? 0);
        counters[m.type] = Math.max(counters[m.type] ?? 0, n);
    }

    const placeholderFor = (type, value) => {
        const existing = valueToPlaceholder.get(value);
        if (existing) return existing;
        counters[type] = (counters[type] ?? 0) + 1;
        const ph = `«${type}_${counters[type]}»`;
        valueToPlaceholder.set(value, ph);
        mappings.push({ placeholder: ph, value, type });
        return ph;
    };

    const applyDetector = (text, det) => {
        const re = new RegExp(det.re.source, det.re.flags.includes("d") ? det.re.flags : det.re.flags + "d");
        let out = "";
        let last = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const span = m.indices?.groups?.val;
            if (!span) continue;
            const [s, e] = span;
            const value = text.slice(s, e);
            if (!value || looksLikePlaceholder(value)) continue;
            if (det.validate && !det.validate(value)) continue;
            out += text.slice(last, s) + placeholderFor(det.type, value);
            last = e;
            if (re.lastIndex <= s) re.lastIndex = e; // guard against zero-width loops
        }
        return out + text.slice(last);
    };

    return {
        redact(text) {
            if (!text) return text;
            let out = text;
            for (const det of DETECTORS) out = applyDetector(out, det);
            return out;
        },
        get mappings() { return mappings; },
    };
}

/** One-shot convenience: redact a single string, returning text + mappings. */
export function redactText(text) {
    const r = createRedactor();
    const redacted = r.redact(text);
    return { redacted, mappings: r.mappings };
}

/**
 * Replace placeholders with their original values. `map` is a Map or plain
 * object of placeholder→value. Recurses through objects/arrays so a whole RCA
 * payload can be re-hydrated for an authorized viewer.
 */
export function rehydrate(value, map) {
    const entries = map instanceof Map ? [...map.entries()] : Object.entries(map ?? {});
    if (entries.length === 0) return value;
    const walk = (v) => {
        if (typeof v === "string") {
            let out = v;
            for (const [ph, val] of entries) if (out.includes(ph)) out = out.split(ph).join(val);
            return out;
        }
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") {
            const o = {};
            for (const k of Object.keys(v)) o[k] = walk(v[k]);
            return o;
        }
        return v;
    };
    return walk(value);
}
