import { describe, it, expect } from "vitest";
import { hashToken, generateRefreshToken, rotateRefreshToken } from "./token.service.js";

// Fake of the drizzle chains token.service uses.
function makeDb() {
    const inserted = [];
    const updates = [];
    return {
        inserted, updates,
        insert: () => ({
            values: (v) => ({
                returning: async () => {
                    const row = { id: `rt-${inserted.length + 1}`, ...v };
                    inserted.push(row);
                    return [row];
                },
            }),
        }),
        update: () => ({
            set: (patch) => ({
                where: async () => { updates.push(patch); },
            }),
        }),
    };
}

describe("refresh token rotation", () => {
    it("stores only the sha256 of the token", () => {
        const raw = generateRefreshToken();
        expect(hashToken(raw)).toMatch(/^[0-9a-f]{64}$/);
        expect(hashToken(raw)).not.toBe(raw);
    });

    it("rotates a live token: new token issued, old one retired", async () => {
        const db = makeDb();
        const presented = {
            id: "rt-old", userId: "u1",
            expiresAt: new Date(Date.now() + 1000_000),
            revokedAt: null, replacedById: null,
        };

        const result = await rotateRefreshToken(db, presented);

        expect(result.ok).toBe(true);
        expect(db.inserted).toHaveLength(1);
        expect(db.inserted[0].token).toBe(hashToken(result.rawToken));
        // old token marked revoked + linked to its replacement
        expect(db.updates.some((u) => u.revokedAt && u.replacedById)).toBe(true);
    });

    it("rejects an expired token without revoking everything", async () => {
        const db = makeDb();
        const presented = {
            id: "rt-old", userId: "u1",
            expiresAt: new Date(Date.now() - 1000),
            revokedAt: null, replacedById: null,
        };

        const result = await rotateRefreshToken(db, presented);
        expect(result).toEqual({ ok: false, reason: "expired" });
        expect(db.updates).toHaveLength(0);
    });

    it("detects reuse of an already-rotated token and revokes the family", async () => {
        const db = makeDb();
        const presented = {
            id: "rt-old", userId: "u1",
            expiresAt: new Date(Date.now() + 1000_000),
            revokedAt: new Date(), replacedById: "rt-new",
        };

        const result = await rotateRefreshToken(db, presented);

        expect(result).toEqual({ ok: false, reason: "reuse-detected" });
        // revoke-all fired
        expect(db.updates.some((u) => u.revokedAt)).toBe(true);
        expect(db.inserted).toHaveLength(0);
    });

    it("handles a missing token", async () => {
        const result = await rotateRefreshToken(makeDb(), null);
        expect(result).toEqual({ ok: false, reason: "missing" });
    });
});