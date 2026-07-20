import { sql } from "drizzle-orm";

// Incident lifecycle for signal-driven incidents: reopen on a flap, auto-resolve
// on silence. Both are plain SQL against the same partial-unique-index invariant
// the ingest path relies on — at most one OPEN incident per (tenant,
// fingerprint) — so neither needs an application lock.

export const SILENCE_MINUTES = Number(process.env.INGEST_SILENCE_MINUTES ?? 30);
export const FLAP_COOLDOWN_MINUTES = Number(process.env.INGEST_FLAP_COOLDOWN_MINUTES ?? 15);

/**
 * Find-or-create the open incident for this entity — not a time bucket. A fixed
 * window would split one long outage into several incidents the moment a signal
 * lands past the boundary; "is there an open incident for this entity" stays
 * correct however long the outage runs.
 *
 * The partial unique index on (tenant_id, fingerprint) WHERE status = 'open'
 * does the deduplication, which also closes the race where two simultaneous
 * signals both find nothing open and both insert — including the case where
 * another request reopened a resolved incident in between. `xmax = 0`
 * distinguishes a fresh insert from an update, and that is what gates the
 * expensive part: only a genuinely new incident enqueues an LLM analysis.
 */
export async function findOrCreateOpenIncident(db, { tenantId, fingerprint, entity, title, description }) {
    const result = await db.execute(sql`
        INSERT INTO incidents
            (tenant_id, title, description, status, fingerprint, entity, signal_count, last_seen_at)
        VALUES (${tenantId}, ${title}, ${description}, 'open', ${fingerprint}, ${entity}, 1, now())
        ON CONFLICT (tenant_id, fingerprint) WHERE status = 'open'
        DO UPDATE SET
            signal_count = incidents.signal_count + 1,
            last_seen_at = now()
        RETURNING id, (xmax = 0) AS created, false AS reopened, signal_count
    `);
    return result.rows[0];
}

/**
 * A flapping service must not accumulate one incident per flap. If this entity
 * resolved recently, the re-fire is the same episode continuing — reopen that
 * incident instead of opening a new one.
 *
 * Ordering matters: ingest tries this BEFORE the insert. If it finds nothing and
 * another request reopens concurrently, the follow-on insert simply conflicts on
 * the partial unique index and attaches to the reopened row. Either way one
 * incident, and no lock.
 *
 * @returns the reopened incident, or undefined when there is nothing to reopen
 */
export async function reopenRecentlyResolved(db, { tenantId, fingerprint, cooldownMinutes = FLAP_COOLDOWN_MINUTES }) {
    const result = await db.execute(sql`
        UPDATE incidents SET
            status = 'open',
            signal_count = signal_count + 1,
            last_seen_at = now(),
            resolved_at = NULL,
            resolution = NULL
        WHERE id = (
            SELECT id FROM incidents
            WHERE tenant_id = ${tenantId}
              AND fingerprint = ${fingerprint}
              AND status = 'resolved'
              AND resolved_at > now() - make_interval(secs => ${cooldownMinutes * 60}::double precision)
            ORDER BY resolved_at DESC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id, false AS created, true AS reopened, signal_count
    `);
    return result.rows[0];
}

/**
 * Silence means the alert cleared. Without this, every entity that ever fired
 * holds its fingerprint slot forever, so a later genuine recurrence can only
 * ever attach to the original incident and would never trigger a fresh analysis.
 *
 * Scoped to fingerprint IS NOT NULL: a human-opened incident going quiet is not
 * evidence it is fixed.
 *
 * Idempotent by construction — the WHERE clause excludes anything already
 * resolved — so running it concurrently in several processes is harmless and it
 * needs no leader election.
 */
export async function resolveStaleIncidents(db, { silenceMinutes = SILENCE_MINUTES } = {}) {
    const result = await db.execute(sql`
        UPDATE incidents SET
            status = 'resolved',
            resolved_at = now(),
            resolution = 'auto-resolved: no signals for ' || ${silenceMinutes}::text || 'm'
        WHERE status = 'open'
          AND fingerprint IS NOT NULL
          AND last_seen_at < now() - make_interval(secs => ${silenceMinutes * 60}::double precision)
        RETURNING id, entity, signal_count
    `);
    return result.rows;
}

/**
 * Runs the sweep on a timer. unref'd so it never holds the process open, and
 * failures are logged rather than thrown — a sweep that cannot run is a stale
 * incident, not a reason to take the API down with it.
 *
 * ponytail: setInterval, not a BullMQ repeatable job. The sweep is idempotent
 * SQL, so duplicate runs across instances are harmless and none of the queue
 * machinery (scheduling, retries, dedup) buys anything here. Move it to a
 * repeatable job if it ever needs retry semantics or a run history.
 */
export function startLifecycleSweeper(db, {
    log,
    intervalMs = Number(process.env.INGEST_SWEEP_INTERVAL_MS ?? 60_000),
    silenceMinutes,
} = {}) {
    const timer = setInterval(async () => {
        try {
            const resolved = await resolveStaleIncidents(db, { silenceMinutes });
            if (resolved.length) {
                log?.info(
                    { count: resolved.length, entities: resolved.map((r) => r.entity) },
                    "[Lifecycle] auto-resolved silent incidents"
                );
            }
        } catch (err) {
            log?.error({ err }, "[Lifecycle] sweep failed");
        }
    }, intervalMs);
    timer.unref();
    return timer;
}
