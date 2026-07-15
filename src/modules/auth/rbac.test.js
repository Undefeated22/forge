import { describe, it, expect } from "vitest";
import { PERMISSIONS, ROLES, ROLE_RANK, ASSIGNABLE_ROLES, roleHasPermission } from "./rbac.js";

describe("rbac role → permission mapping", () => {
    it("viewer can read but never write", () => {
        expect(roleHasPermission("viewer", PERMISSIONS.INCIDENTS_READ)).toBe(true);
        expect(roleHasPermission("viewer", PERMISSIONS.INCIDENTS_CREATE)).toBe(false);
        expect(roleHasPermission("viewer", PERMISSIONS.EVIDENCE_UPLOAD)).toBe(false);
        expect(roleHasPermission("viewer", PERMISSIONS.MEMBERS_MANAGE)).toBe(false);
    });

    it("member can create incidents but not manage members", () => {
        expect(roleHasPermission("member", PERMISSIONS.INCIDENTS_CREATE)).toBe(true);
        expect(roleHasPermission("member", PERMISSIONS.MEMBERS_INVITE)).toBe(false);
        expect(roleHasPermission("member", PERMISSIONS.ORG_MANAGE)).toBe(false);
    });

    it("admin can manage members but not the org itself", () => {
        expect(roleHasPermission("admin", PERMISSIONS.MEMBERS_MANAGE)).toBe(true);
        expect(roleHasPermission("admin", PERMISSIONS.ORG_MANAGE)).toBe(false);
    });

    it("owner holds every permission", () => {
        for (const p of Object.values(PERMISSIONS)) {
            expect(roleHasPermission("owner", p)).toBe(true);
        }
    });

    it("roles are strictly nested: each rank is a superset of the one below", () => {
        const ordered = ["viewer", "member", "admin", "owner"];
        for (let i = 1; i < ordered.length; i++) {
            for (const p of ROLES[ordered[i - 1]]) {
                expect(ROLES[ordered[i]].has(p)).toBe(true);
            }
            expect(ROLE_RANK[ordered[i]]).toBeGreaterThan(ROLE_RANK[ordered[i - 1]]);
        }
    });

    it("unknown roles hold no permissions", () => {
        expect(roleHasPermission("superuser", PERMISSIONS.INCIDENTS_READ)).toBe(false);
        expect(roleHasPermission(undefined, PERMISSIONS.INCIDENTS_READ)).toBe(false);
    });

    it("owner is never assignable via invite/role-change", () => {
        expect(ASSIGNABLE_ROLES).not.toContain("owner");
    });
});