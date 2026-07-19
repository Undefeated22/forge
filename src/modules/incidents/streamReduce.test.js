import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import {
    reduceLogStream,
    BinaryFileError,
    MAX_RETAINED_LINES,
} from "./streamReduce.js";

const streamOf = (data) => Readable.from([Buffer.isBuffer(data) ? data : Buffer.from(data)]);

describe("reduceLogStream", () => {
    it("drops blank lines and trims, counting only real lines", async () => {
        const { reducedText, totalLines, retainedLines, truncated } =
            await reduceLogStream(streamOf("  a  \n\n   \nb\n"));
        expect(reducedText).toBe("a\nb");
        expect(totalLines).toBe(2);
        expect(retainedLines).toBe(2);
        expect(truncated).toBe(false);
    });

    it("keeps the chronologically-earliest lines when it must truncate", async () => {
        // More distinct-timestamp lines than the retention cap, latest first,
        // spaced a full second apart so ms-granularity Date keys stay distinct.
        const base = Date.parse("2026-07-14T10:00:00Z");
        const lines = [];
        for (let i = MAX_RETAINED_LINES * 2; i >= 1; i--) {
            lines.push(`${new Date(base + i * 1000).toISOString()} line ${i}`);
        }
        const { reducedText, totalLines, retainedLines, truncated } =
            await reduceLogStream(streamOf(lines.join("\n")));

        expect(totalLines).toBe(MAX_RETAINED_LINES * 2);
        expect(retainedLines).toBeLessThanOrEqual(MAX_RETAINED_LINES * 2);
        expect(truncated).toBe(true);
        const kept = reducedText.split("\n");
        expect(kept[0]).toContain("line 1"); // earliest survives
    }, 20_000); // heavy: builds & streams ~400k lines — allow headroom under load

    it("retains high-severity lines even when buried late in a huge log", async () => {
        const base = Date.parse("2026-07-14T10:00:00Z");
        const lines = [];
        for (let i = 1; i <= MAX_RETAINED_LINES; i++) {
            lines.push(`${new Date(base + i * 1000).toISOString()} INFO routine chatter ${i}`);
        }
        // The smoking gun sits at the very end, far past the earliest-head cutoff.
        const gunTs = new Date(base + (MAX_RETAINED_LINES + 5) * 1000).toISOString();
        lines.push(`${gunTs} FATAL database connection pool exhausted`);

        const { reducedText, severeLines } = await reduceLogStream(streamOf(lines.join("\n")));
        expect(severeLines).toBe(1);
        expect(reducedText).toContain("FATAL database connection pool exhausted");
    }, 20_000); // heavy: builds & streams ~200k lines — allow headroom under load

    it("sorts untimestamped lines after timestamped ones", async () => {
        const { reducedText } = await reduceLogStream(
            streamOf("no timestamp here\n2026-07-14T10:00:01Z real event\n")
        );
        const kept = reducedText.split("\n");
        expect(kept[0]).toContain("real event");
        expect(kept[1]).toBe("no timestamp here");
    });

    it("transparently decompresses gzip uploads", async () => {
        const raw = "2026-07-14T10:00:01Z ERROR boom\n2026-07-14T10:00:02Z ok\n";
        const gz = zlib.gzipSync(Buffer.from(raw));
        const { reducedText, totalLines } = await reduceLogStream(streamOf(gz), {
            filename: "app.log.gz",
        });
        expect(totalLines).toBe(2);
        expect(reducedText).toContain("ERROR boom");
    });

    it("detects gzip by magic bytes even without a .gz filename", async () => {
        const gz = zlib.gzipSync(Buffer.from("2026-07-14T10:00:01Z hello\n"));
        const { reducedText } = await reduceLogStream(streamOf(gz));
        expect(reducedText).toContain("hello");
    });

    it("rejects binary files instead of storing mojibake", async () => {
        const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]);
        await expect(reduceLogStream(streamOf(binary))).rejects.toBeInstanceOf(BinaryFileError);
    });

    it("handles an empty upload without throwing", async () => {
        const { reducedText, totalLines } = await reduceLogStream(Readable.from([]));
        expect(reducedText).toBe("");
        expect(totalLines).toBe(0);
    });
});
