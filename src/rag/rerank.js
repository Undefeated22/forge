// Reranking stage for RAG retrieval. Pure and model-free so it's fast and fully
// testable. Vector search alone over-weights fuzzy semantic proximity and often
// returns several near-duplicate chunks; reranking fixes both:
//
//   1. Hybrid score — blend the vector cosine similarity with a lexical overlap
//      signal, so a chunk that literally mentions the query's terms (component
//      names, error strings, CLI flags) is rewarded, not just a vibe match.
//   2. MMR (Maximal Marginal Relevance) — greedily pick results that are
//      relevant AND novel relative to what's already chosen, so the final
//      context isn't three paraphrases of the same paragraph.

const STOP = new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
    "was", "were", "be", "with", "as", "at", "by", "it", "this", "that", "from",
    "we", "you", "i", "if", "then", "than", "so", "but", "not", "no",
]);

export function tokenize(text) {
    return (text ?? "")
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/)
        .filter((t) => t.length > 1 && !STOP.has(t));
}

// Jaccard-style overlap of the query terms present in a text (in [0,1]).
export function lexicalOverlap(queryTokens, text) {
    const q = queryTokens instanceof Set ? queryTokens : new Set(queryTokens);
    if (q.size === 0) return 0;
    const t = new Set(tokenize(text));
    let hits = 0;
    for (const term of q) if (t.has(term)) hits++;
    return hits / q.size;
}

// Cosine-ish similarity between two texts via their token sets — the MMR
// diversity proxy (avoids needing chunk embeddings at rerank time).
function tokenSetSimilarity(aTokens, bText) {
    const a = aTokens;
    const b = new Set(tokenize(bText));
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / Math.sqrt(a.size * b.size);
}

/**
 * Reciprocal Rank Fusion: merge several ranked lists into one, scoring each item
 * by sum(1 / (k0 + rank)) across the lists it appears in. This is how we fuse the
 * Postgres-exact (keyword/ILIKE) arm with the pgvector-semantic arm — it needs no
 * score calibration between the two (their raw scores aren't comparable), only
 * their rank orders, and it rewards items that BOTH arms surface.
 *
 * @param {Array<Array<object>>} lists — ranked lists (best-first) of items.
 * @param {{k0?:number, idKey?:string}} [opts]
 * @returns {Array<object & {rrf:number}>} fused items, best-first, de-duplicated by id.
 */
export function reciprocalRankFusion(lists, { k0 = 60, idKey = "id" } = {}) {
    const byId = new Map();
    for (const list of lists) {
        list.forEach((item, rank) => {
            const id = item[idKey];
            if (id == null) return;
            const prev = byId.get(id);
            const contribution = 1 / (k0 + rank);
            if (prev) prev.rrf += contribution;
            else byId.set(id, { ...item, rrf: contribution });
        });
    }
    return [...byId.values()].sort((a, b) => b.rrf - a.rrf);
}

/**
 * Rerank vector-search candidates.
 * @param {string} query
 * @param {Array<{id?:string, content:string, similarity:number}>} candidates
 *   `similarity` is cosine in [0,1] from pgvector.
 * @param {{k?:number, alpha?:number, lambda?:number}} [opts]
 *   alpha: weight on vector vs lexical (0.7 = mostly vector).
 *   lambda: MMR relevance vs diversity (1 = pure relevance, 0 = pure diversity).
 * @returns {Array<candidate & {score:number, lexical:number, rerankScore:number}>}
 */
export function rerank(query, candidates, { k = 5, alpha = 0.7, lambda = 0.7 } = {}) {
    if (!candidates?.length) return [];
    const qTokens = tokenize(query);
    const qSet = new Set(qTokens);

    // Hybrid relevance score per candidate.
    const scored = candidates.map((c) => {
        const lexical = lexicalOverlap(qSet, c.content);
        const score = alpha * (c.similarity ?? 0) + (1 - alpha) * lexical;
        return { ...c, lexical, score };
    });

    // MMR selection.
    const selected = [];
    const pool = [...scored];
    const selectedTokenSets = [];
    while (selected.length < Math.min(k, scored.length) && pool.length) {
        let bestIdx = 0;
        let bestVal = -Infinity;
        for (let i = 0; i < pool.length; i++) {
            const cand = pool[i];
            let maxSimToSelected = 0;
            for (const ts of selectedTokenSets) {
                maxSimToSelected = Math.max(maxSimToSelected, tokenSetSimilarity(ts, cand.content));
            }
            const mmr = lambda * cand.score - (1 - lambda) * maxSimToSelected;
            if (mmr > bestVal) {
                bestVal = mmr;
                bestIdx = i;
            }
        }
        const [chosen] = pool.splice(bestIdx, 1);
        chosen.rerankScore = bestVal;
        selected.push(chosen);
        selectedTokenSets.push(new Set(tokenize(chosen.content)));
    }
    return selected;
}
