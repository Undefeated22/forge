import { describe, it, expect } from "vitest";
import { getReportHandler } from "./report.controller.js";

// Minimal fake of drizzle's fluent query chain: any method returns the chain,
// awaiting it yields the next queued result. One entry per query the handler runs.
function makeDb(...results) {
    let i = 0;
    const chain = new Proxy(function () {}, {
        get(_, prop) {
            if (prop === "then") {
                const value = results[i++];
                return (resolve) => resolve(value);
            }
            return () => chain;
        },
    });
    return chain;
}

function makeReply() {
    const reply = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
    return reply;
}

function makeReq(db, { incidentId = "inc-1", organizationId = "org-a" } = {}) {
    return {
        params: { incidentId },
        user: { id: "user-1", organizationId },
        server: { db },
        log: { error: () => {} },
    };
}

const MY_ORG = "org-a";
const OTHER_ORG = "org-b";

describe("getReportHandler tenancy isolation", () => {
    it("returns the latest report for an incident in the caller's org", async () => {
        const incident = { id: "inc-1", tenantId: MY_ORG };
        const report = { id: "rep-1", incidentId: "inc-1", status: "completed" };
        const req = makeReq(makeDb([incident], [report]));
        const reply = makeReply();

        const result = await getReportHandler(req, reply);

        expect(reply.statusCode).toBe(200);
        expect(result).toEqual({ success: true, report });
    });

    it("404s when the incident belongs to another org, without revealing it exists", async () => {
        const foreignIncident = { id: "inc-1", tenantId: OTHER_ORG };
        const req = makeReq(makeDb([foreignIncident]));
        const reply = makeReply();

        await getReportHandler(req, reply);

        expect(reply.statusCode).toBe(404);
        expect(reply.body).toEqual({ error: "Report not found for this incident" });
    });

    it("404s with the identical body when the incident does not exist at all", async () => {
        const req = makeReq(makeDb([]));
        const reply = makeReply();

        await getReportHandler(req, reply);

        expect(reply.statusCode).toBe(404);
        // same message as the cross-tenant case — no enumeration oracle
        expect(reply.body).toEqual({ error: "Report not found for this incident" });
    });

    it("404s when the incident exists but has no report yet", async () => {
        const incident = { id: "inc-1", tenantId: MY_ORG };
        const req = makeReq(makeDb([incident], []));
        const reply = makeReply();

        await getReportHandler(req, reply);

        expect(reply.statusCode).toBe(404);
    });
});
