// Monte Carlo tree search over an investigation, with a real budget.
//
// HONEST FRAMING, because "MCTS" implies more than this does:
//
// Textbook MCTS does random playouts to a terminal state and backs up the
// outcome. There is no terminal state here and no cheap simulator — every
// "playout" would be a real LLM call costing real money and 0.5-6s of queueing.
// So this is the variant used whenever rollouts are expensive: each action's
// value is its IMMEDIATE measured reward (information gain), and the tree
// explores which SEQUENCE of retrievals collapses uncertainty fastest. Closer to
// a tree bandit than to AlphaGo, and saying so is more useful than implying a
// depth of search that is not being paid for.
//
// The parts that are genuinely MCTS and genuinely matter:
//
//   - UCT balances exploiting a retrieval that already paid off against trying
//     one never sampled.
//   - Progressive widening keeps a large branching factor from spending the
//     whole budget on breadth at depth 1.
//   - The budget is a hard cap on real calls, not a convergence criterion.

/**
 * Exploration constant. sqrt(2) is the standard choice ONLY when rewards live in
 * [0,1] — the caller must normalise, or this silently becomes either pure greed
 * (rewards too small) or a random walk (too large).
 */
export const DEFAULT_C = Math.SQRT2;

function makeNode(state, parent = null, action = null) {
    return { state, parent, action, children: [], visits: 0, totalReward: 0, untried: null };
}

/**
 * How many children a node is allowed, given how often it has been visited.
 *
 * Without this the root expands every chunk in the log before evaluating any of
 * them twice, which spends the entire budget learning nothing about depth. The
 * usual k*N^alpha form: alpha=0.5 lets width grow with the square root of visits.
 */
export function allowedChildren(visits, { k = 2, alpha = 0.5 } = {}) {
    return Math.max(1, Math.ceil(k * Math.pow(visits, alpha)));
}

/** UCT score. Unvisited children are infinitely attractive, by definition. */
export function uct(child, parentVisits, c = DEFAULT_C) {
    if (child.visits === 0) return Infinity;
    const exploit = child.totalReward / child.visits;
    const explore = c * Math.sqrt(Math.log(parentVisits) / child.visits);
    return exploit + explore;
}

/**
 * Run the search.
 *
 * @param {object} opts
 * @param {*} opts.rootState
 * @param {(state) => any[]} opts.actionsFor        legal actions in a state
 * @param {(state, action) => Promise<{state,reward}>} opts.apply
 *        Performs the retrieval and returns the new state plus the reward.
 *        Reward MUST be normalised to [0,1] — see DEFAULT_C.
 * @param {number} opts.budget       hard cap on apply() calls (i.e. on money)
 * @param {(state) => boolean} [opts.isTerminal]
 * @returns {Promise<{bestPath, rootValue, evaluations, tree}>}
 */
export async function search({
    rootState,
    actionsFor,
    apply,
    budget = 12,
    explorationC = DEFAULT_C,
    widening = {},
    isTerminal = () => false,
    stopEarly = () => false,
    onStep = null,
}) {
    const root = makeNode(rootState);
    root.untried = [...actionsFor(rootState)];
    if (!root.untried.length) {
        return { bestPath: [], rootValue: 0, evaluations: 0, tree: root, exhausted: true };
    }

    let evaluations = 0;

    // Is there anything left worth spending budget on? Without this the search
    // SPINS: once every path bottoms out at a terminal state, selection keeps
    // landing on terminal nodes and `continue`s WITHOUT consuming budget, so
    // `evaluations < budget` never advances. A stall counter would paper over
    // it; asking the tree directly is the actual question.
    const hasExpandable = (n) => {
        if (isTerminal(n.state)) return false;
        if (n.untried === null || n.untried.length > 0) return true;
        return n.children.some(hasExpandable);
    };

    while (evaluations < budget && hasExpandable(root)) {
        // ---- SELECT: descend by UCT while the node is fully widened ----
        let node = root;
        while (
            !isTerminal(node.state) &&
            node.children.length &&
            (!node.untried?.length || node.children.length >= allowedChildren(node.visits, widening))
        ) {
            node = node.children.reduce((best, ch) =>
                uct(ch, node.visits, explorationC) > uct(best, node.visits, explorationC) ? ch : best
            );
        }

        // Selection can still land on a dead end — a terminal state, or a node
        // whose actions are all used up. Back up a zero so UCT stops returning
        // here, then let the loop guard decide whether anything remains.
        if (node.untried === null && !isTerminal(node.state)) {
            node.untried = [...actionsFor(node.state)];
        }
        if (isTerminal(node.state) || !node.untried?.length) {
            backpropagate(node, 0);
            continue;
        }

        // ---- EXPAND: one new child, one real call ----

        const action = node.untried.shift();
        const { state: nextState, reward } = await apply(node.state, action);
        evaluations++;

        const child = makeNode(nextState, node, action);
        node.children.push(child);

        // ---- BACKPROPAGATE ----
        backpropagate(child, reward);
        onStep?.({ evaluations, action, reward, depth: depthOf(child) });

        // GLOBAL stop, distinct from isTerminal. isTerminal only marks one
        // branch dead, so a state that already answers the question still leaves
        // the search exploring alternative FIRST moves — paying for a dozen more
        // calls to re-answer what it just learned. When the goal is met, stop.
        if (stopEarly(child.state, reward)) break;
    }

    return {
        bestPath: extractBestPath(root),
        rootValue: root.visits ? root.totalReward / root.visits : 0,
        evaluations,
        tree: root,
        exhausted: evaluations < budget,
    };
}

function backpropagate(node, reward) {
    for (let n = node; n; n = n.parent) {
        n.visits++;
        n.totalReward += reward;
    }
}

function depthOf(node) {
    let d = 0;
    for (let n = node; n.parent; n = n.parent) d++;
    return d;
}

/**
 * The recommended sequence: follow the most-VISITED child at each level.
 *
 * Most-visited rather than highest-mean is deliberate and is the standard choice:
 * a child sampled once with a lucky reward has a great mean and no evidence.
 * Visit count is the estimate the search actually spent budget establishing.
 */
export function extractBestPath(root) {
    const path = [];
    let node = root;
    while (node.children.length) {
        node = node.children.reduce((best, ch) => (ch.visits > best.visits ? ch : best));
        path.push({
            action: node.action,
            visits: node.visits,
            meanReward: node.visits ? node.totalReward / node.visits : 0,
        });
    }
    return path;
}

/** Flat summary of what the search actually did — for storing as an audit trail. */
export function summarize(root) {
    const nodes = [];
    const walk = (n, depth) => {
        if (n.action !== null) {
            nodes.push({
                action: n.action,
                depth,
                visits: n.visits,
                meanReward: n.visits ? n.totalReward / n.visits : 0,
            });
        }
        n.children.forEach((c) => walk(c, depth + 1));
    };
    walk(root, 0);
    return nodes.sort((a, b) => b.visits - a.visits || b.meanReward - a.meanReward);
}
