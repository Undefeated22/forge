// Opinion pooling over a shared hypothesis set.
//
// Free-text hypotheses cannot be averaged. Beliefs on the simplex can, and the
// averaging has a convergence theorem attached rather than a hope. Each agent i
// holds p_i ∈ Δ^(m-1) over the SAME H; per hypothesis coordinate the vector of
// agent beliefs evolves as
//
//     x(t+1) = x(t) − αL x(t) = (I − αL) x(t),        L = D − W
//
// where W is the agent communication graph and L its Laplacian. This is the
// matrix form of the per-agent rule x_i ← x_i + α Σ_j W_ij (x_j − x_i).
//
// Convergence is a theorem, not a hope: for a CONNECTED graph and
// 0 < α < 1/λ_max(L) the system converges to consensus, at a rate governed by
// the Fiedler value λ_2(L) — error shrinks like (1 − αλ_2)^t. Both conditions
// are checked here rather than assumed, because both fail silently: a
// disconnected graph converges to per-clique consensus that looks like agreement,
// and too large an α oscillates or diverges while still returning numbers.

/**
 * Largest step size that is safe on BOTH counts.
 *
 * Convergence needs α < 2/λ_max. Keeping every iterate ON the simplex needs the
 * stronger α ≤ 1/max_degree, which makes (I − αL) non-negative and row-stochastic
 * — otherwise a "probability" can go negative mid-iteration and the KL halting
 * test starts returning NaN. Gershgorin bounds λ_max ≤ 2·max_degree, so the
 * stochasticity condition implies the convergence one; satisfy the strict one and
 * both hold.
 */
export function safeStepSize(weights) {
    const degrees = weights.map((row) => row.reduce((s, w) => s + w, 0));
    const maxDegree = Math.max(...degrees, 0);
    if (maxDegree <= 0) return 0;
    return 1 / (maxDegree + 1);
}

/**
 * Complete graph: every agent hears every other. The default because it
 * maximises λ_2 (fastest convergence) and is trivially connected — a sparse
 * topology is only worth modelling once agents are expensive to poll, which they
 * are not here since every belief is already computed before pooling starts.
 */
export function completeGraph(n) {
    return Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? 0 : 1))
    );
}

/** L = D − W */
export function laplacian(weights) {
    return weights.map((row, i) => {
        const degree = row.reduce((s, w) => s + w, 0);
        return row.map((w, j) => (i === j ? degree - w : -w));
    });
}

/**
 * Is the agent graph connected? Without this the theorem does not apply: a
 * disconnected graph converges to consensus WITHIN each component, which reads
 * as agreement while actually being two camps that never spoke.
 */
export function isConnected(weights) {
    const n = weights.length;
    if (n === 0) return false;
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) {
        const i = stack.pop();
        for (let j = 0; j < n; j++) {
            if (weights[i][j] > 0 && !seen.has(j)) { seen.add(j); stack.push(j); }
        }
    }
    return seen.size === n;
}

/** KL(p ‖ q) in nats. */
export function kl(p, q) {
    let sum = 0;
    for (let i = 0; i < p.length; i++) {
        if (p[i] <= 0) continue;          // 0·log0 = 0
        // q[i] can only be 0 here if EVERY agent put zero mass on it, in which
        // case p[i] is 0 too and we already skipped. Guard anyway.
        if (q[i] <= 0) return Infinity;
        sum += p[i] * Math.log(p[i] / q[i]);
    }
    return sum;
}

/**
 * Align agent beliefs onto one hypothesis ordering.
 *
 * Pooling is only meaningful over a SHARED H. An agent that invented its own
 * hypotheses is not disagreeing about probabilities, it is answering a different
 * question, and averaging the two produces a number with no interpretation.
 * Missing hypotheses get 0 mass and the row is renormalised.
 */
export function alignBeliefs(agents, hypothesisIds) {
    return agents.map((agent) => {
        const byId = new Map((agent.belief ?? []).map((h) => [h.id, h.prior]));
        const row = hypothesisIds.map((id) => Math.max(0, byId.get(id) ?? 0));
        const total = row.reduce((s, v) => s + v, 0);
        return total > 0 ? row.map((v) => v / total) : hypothesisIds.map(() => 1 / hypothesisIds.length);
    });
}

/**
 * Run the consensus dynamics to agreement.
 *
 * @param {{id:string, belief:{id,prior}[]}[]} agents
 *        Agents that ABSTAINED must be filtered out before this call — an agent
 *        with no information voting uniform is not neutral, it actively drags
 *        the pool toward maximum entropy.
 * @param {string[]} hypothesisIds the shared H, in canonical order
 */
export function poolBeliefs(agents, hypothesisIds, {
    weights = null,
    alpha = null,
    epsilon = 1e-3,
    maxIterations = 500,
} = {}) {
    const voting = agents.filter((a) => a.belief?.length);
    if (!voting.length || !hypothesisIds.length) return null;

    const n = voting.length;
    const m = hypothesisIds.length;

    // One agent is not a council. Pooling is the identity here, and saying so is
    // more honest than reporting "converged in 0 iterations" as if it meant
    // agreement was reached.
    if (n === 1) {
        const only = alignBeliefs(voting, hypothesisIds)[0];
        return {
            pooled: only, iterations: 0, converged: true, singleAgent: true,
            initialDisagreement: 0, finalDisagreement: 0,
            perAgent: [{ id: voting[0].id, initialKL: 0, finalKL: 0 }],
            alpha: 0, fiedler: 0, connected: true,
        };
    }

    const W = weights ?? completeGraph(n);
    const connected = isConnected(W);
    const L = laplacian(W);
    const step = alpha ?? safeStepSize(W);

    let X = alignBeliefs(voting, hypothesisIds);
    const initial = X.map((row) => [...row]);

    // Linear pool p̄ = (1/n) Σ p_i — the value consensus provably converges to,
    // and the reference the halting test measures against.
    //
    // NOT weighted. On a symmetric graph the dynamics converges to the UNWEIGHTED
    // average; that is what the theorem gives you. Trust weighting requires a
    // non-symmetric row-stochastic (DeGroot) update whose limit is the left
    // Perron eigenvector — a different construction, not a parameter. An earlier
    // draft accepted a per-agent `weight` and applied it after convergence, where
    // every row is already identical and it silently did nothing. See ROADMAP.
    const linearPool = (rows) => {
        const out = new Array(m).fill(0);
        rows.forEach((row) => row.forEach((v, k) => { out[k] += v / rows.length; }));
        return out;
    };

    const maxKL = (rows) => {
        const bar = linearPool(rows);
        return Math.max(...rows.map((row) => kl(row, bar)));
    };

    const initialDisagreement = maxKL(initial);

    let iterations = 0;
    let converged = false;
    for (; iterations < maxIterations; iterations++) {
        // Halting measured properly ON THE SIMPLEX — Euclidean distance between
        // probability vectors is not the right notion of "these agree".
        if (maxKL(X) < epsilon) { converged = true; break; }

        const next = X.map((row, i) =>
            row.map((v, k) => v - step * L[i].reduce((s, lij, j) => s + lij * X[j][k], 0))
        );
        X = next;
    }

    const pooled = linearPool(X);
    const finalBar = pooled;

    return {
        pooled,
        iterations,
        converged,
        singleAgent: false,
        connected,
        alpha: step,
        // λ_2 governs the rate; reported so a slow run is explainable rather
        // than mysterious.
        fiedler: fiedlerValue(L),
        // The signal worth reading. HIGH initial disagreement that converges is
        // a robust answer — independent methods were reconciled by evidence.
        // NEAR-ZERO initial disagreement is NOT reassurance: it means the agents
        // never actually disagreed, which is the signature of uniform
        // hallucination the heterogeneous council exists to detect.
        initialDisagreement,
        finalDisagreement: maxKL(X),
        perAgent: voting.map((a, i) => ({
            id: a.id,
            initialKL: kl(initial[i], linearPool(initial)),
            finalKL: kl(X[i], finalBar),
        })),
    };
}

/**
 * Algebraic connectivity λ_2(L), the second-smallest eigenvalue.
 *
 * Computed by deflated power iteration on (cI − L): L's smallest eigenvalue is
 * always 0 with eigenvector 1, so projecting that out leaves λ_2 as the
 * dominant one of the shifted matrix. Approximate and cheap — this is a
 * diagnostic for explaining convergence rate, not a value anything branches on.
 */
export function fiedlerValue(L, iterations = 200) {
    const n = L.length;
    if (n < 2) return 0;
    const c = Math.max(...L.map((row, i) => row[i])) * 2 + 1;   // shift to make it PSD-dominant

    let v = Array.from({ length: n }, (_, i) => Math.sin(i + 1));
    const orthogonalize = (x) => {
        const mean = x.reduce((s, u) => s + u, 0) / n;           // remove the 1 direction
        return x.map((u) => u - mean);
    };
    const normalize = (x) => {
        const norm = Math.hypot(...x);
        return norm > 1e-12 ? x.map((u) => u / norm) : x;
    };

    v = normalize(orthogonalize(v));
    for (let t = 0; t < iterations; t++) {
        const w = v.map((_, i) => c * v[i] - L[i].reduce((s, lij, j) => s + lij * v[j], 0));
        v = normalize(orthogonalize(w));
    }
    const Lv = v.map((_, i) => L[i].reduce((s, lij, j) => s + lij * v[j], 0));
    const rayleigh = v.reduce((s, vi, i) => s + vi * Lv[i], 0);
    return Math.max(0, rayleigh);
}
