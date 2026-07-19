// Document chunking for RAG ingestion. Pure and dependency-free so it's fully
// unit-testable. Markdown-aware: it keeps each chunk inside a single heading
// section where possible and prepends the section's heading trail for context,
// so a retrieved chunk carries "where in the doc it came from" into the prompt.

const DEFAULTS = {
    maxChars: 1200, // ~300 tokens/chunk — small enough to retrieve precisely
    overlap: 200,   // carry the tail of the previous chunk for continuity
    minChars: 60,   // drop trailing scraps smaller than this (merged instead)
};

// ~4 chars/token is a decent English heuristic; good enough for budgeting.
export function estimateTokens(text) {
    return Math.ceil((text?.length ?? 0) / 4);
}

function isHeading(line) {
    return /^#{1,6}\s+\S/.test(line);
}
function headingLevel(line) {
    return (line.match(/^#+/) || [""])[0].length;
}
function headingText(line) {
    return line.replace(/^#+\s+/, "").trim();
}

// Split raw text into sections keyed by their heading trail (breadcrumb of the
// enclosing headings, e.g. "Runbooks > Database > Failover").
function splitSections(text) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const sections = [];
    const trail = []; // [{level, text}]
    let body = [];

    const flush = () => {
        const content = body.join("\n").trim();
        if (content) sections.push({ heading: trail.map((h) => h.text).join(" > "), content });
        body = [];
    };

    for (const line of lines) {
        if (isHeading(line)) {
            flush();
            const level = headingLevel(line);
            while (trail.length && trail[trail.length - 1].level >= level) trail.pop();
            trail.push({ level, text: headingText(line) });
        } else {
            body.push(line);
        }
    }
    flush();
    return sections;
}

// Pack paragraphs into <=maxChars pieces, hard-splitting any single paragraph
// that alone exceeds maxChars. Adds `overlap` chars of tail-carryover between
// consecutive pieces so context isn't severed at a boundary.
function packSection(content, { maxChars, overlap, minChars }) {
    const paras = content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const pieces = [];
    let cur = "";

    const push = () => {
        if (!cur) return;
        pieces.push(cur);
        cur = overlap > 0 ? cur.slice(-overlap) : "";
    };

    for (let para of paras) {
        while (para.length > maxChars) {
            // Hard-split an oversized paragraph on the last space before the cap.
            if (cur && cur.length + 1 + para.length > maxChars) push();
            const room = maxChars - (cur ? cur.length + 1 : 0);
            let cut = para.lastIndexOf(" ", room);
            if (cut <= 0) cut = room; // no space — split mid-token as last resort
            const head = para.slice(0, cut).trim();
            cur = cur ? `${cur}\n${head}` : head;
            push();
            para = para.slice(cut).trim();
        }
        if (cur && cur.length + 2 + para.length > maxChars) push();
        cur = cur ? `${cur}\n\n${para}` : para;
    }
    // Final piece: merge a tiny scrap back into the previous piece.
    if (cur) {
        const tail = overlap > 0 ? "" : cur; // avoid double-counting overlap seed
        void tail;
        if (cur.length < minChars && pieces.length) {
            pieces[pieces.length - 1] = `${pieces[pieces.length - 1]}\n\n${cur}`.trim();
        } else {
            pieces.push(cur);
        }
    }
    return pieces;
}

/**
 * Chunk a document into retrieval units.
 * @param {string} text
 * @param {{maxChars?:number, overlap?:number, minChars?:number}} [opts]
 * @returns {Array<{index:number, content:string, heading:string, tokenEstimate:number}>}
 */
export function chunkDocument(text, opts = {}) {
    const cfg = { ...DEFAULTS, ...opts };
    if (cfg.overlap >= cfg.maxChars) throw new Error("overlap must be smaller than maxChars");
    if (!text || !text.trim()) return [];

    const chunks = [];
    for (const section of splitSections(text)) {
        for (const piece of packSection(section.content, cfg)) {
            // Prepend the heading trail so the chunk is self-describing in a prompt.
            const content = section.heading ? `[${section.heading}]\n${piece}` : piece;
            chunks.push({
                index: chunks.length,
                content,
                heading: section.heading,
                tokenEstimate: estimateTokens(content),
            });
        }
    }
    return chunks;
}
