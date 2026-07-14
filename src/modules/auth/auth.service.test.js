import { describe, it, expect } from "vitest";
import {
    generateResetToken, hashResetToken, createResetToken, findValidResetToken,
} from "./auth.service.js";

// Fake of the drizzle chains this module uses. Captures inserted values and
// serves canned select results.
function makeDb({ selectResult = [] } = {}) {
    const inserted = [];
    return {
        inserted,
        insert: () => ({
            values: (v) => ({
                returning: async () => { inserted.push(v); return [v]; },
            }),
        }),
        select: () => ({
            from: () => ({
                where: async () => selectResult,
            }),
        }),
    };
}

describe("password reset tokens", () => {
    it("persists only the sha256 hash, never the raw token", async () => {
        const db = makeDb();
        const raw = generateResetToken();

        await createResetToken(db, "user-1", raw, new Date(Date.now() + 3600_000));

        expect(db.inserted).toHaveLength(1);
        expect(db.inserted[0].token).toBe(hashResetToken(raw));
        expect(db.inserted[0].token).not.toBe(raw);
        expect(hashResetToken(raw)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("accepts a matching, unused, unexpired token", async () => {
        const row = {
            id: "tok-1", userId: "user-1", used: false,
            expiresAt: new Date(Date.now() + 3600_000),
        };
        const db = makeDb({ selectResult: [row] });

        expect(await findValidResetToken(db, "whatever")).toEqual(row);
    });

    it("rejects a token that was already used", async () => {
        const row = { id: "tok-1", used: true, expiresAt: new Date(Date.now() + 3600_000) };
        const db = makeDb({ selectResult: [row] });

        expect(await findValidResetToken(db, "whatever")).toBeNull();
    });

    it("rejects an expired token", async () => {
        const row = { id: "tok-1", used: false, expiresAt: new Date(Date.now() - 1000) };
        const db = makeDb({ selectResult: [row] });

        expect(await findValidResetToken(db, "whatever")).toBeNull();
    });

    it("rejects an unknown token", async () => {
        const db = makeDb({ selectResult: [] });
        expect(await findValidResetToken(db, "nope")).toBeNull();
    });
});
