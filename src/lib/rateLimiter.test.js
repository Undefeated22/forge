import { describe, it, expect } from "vitest";
import { createInMemoryRateLimiter } from "./rateLimiter.js";

describe("createInMemoryRateLimiter", () => {
    it("allows the first request", () => {
        const rl = createInMemoryRateLimiter({ now: () => 0 });
        expect(rl.check("u1")).toBe("ok");
    });

    it("rejects a too-fast follow-up within minGap", () => {
        let t = 0;
        const rl = createInMemoryRateLimiter({ minGapMs: 1500, now: () => t });
        expect(rl.check("u1")).toBe("ok");
        t = 1000; expect(rl.check("u1")).toBe("too-fast");
        t = 1600; expect(rl.check("u1")).toBe("ok");
    });

    it("does not consume the window on a rejected attempt", () => {
        let t = 0;
        const rl = createInMemoryRateLimiter({ minGapMs: 1000, maxPerWindow: 2, now: () => t });
        expect(rl.check("u1")).toBe("ok");      // hit 1
        t = 500; expect(rl.check("u1")).toBe("too-fast"); // rejected, not recorded
        t = 1500; expect(rl.check("u1")).toBe("ok");      // hit 2
    });

    it("enforces the per-window ceiling", () => {
        let t = 0;
        const rl = createInMemoryRateLimiter({ windowMs: 60_000, maxPerWindow: 3, minGapMs: 0, now: () => t });
        expect(rl.check("u1")).toBe("ok");
        t = 10; expect(rl.check("u1")).toBe("ok");
        t = 20; expect(rl.check("u1")).toBe("ok");
        t = 30; expect(rl.check("u1")).toBe("rate-limited");
    });

    it("frees capacity as the window slides", () => {
        let t = 0;
        const rl = createInMemoryRateLimiter({ windowMs: 1000, maxPerWindow: 1, minGapMs: 0, now: () => t });
        expect(rl.check("u1")).toBe("ok");
        t = 500; expect(rl.check("u1")).toBe("rate-limited");
        t = 1001; expect(rl.check("u1")).toBe("ok");
    });

    it("isolates subjects from each other", () => {
        let t = 0;
        const rl = createInMemoryRateLimiter({ maxPerWindow: 1, minGapMs: 0, now: () => t });
        expect(rl.check("alice")).toBe("ok");
        expect(rl.check("bob")).toBe("ok"); // different subject, own budget
        t = 1; expect(rl.check("alice")).toBe("rate-limited");
    });
});
