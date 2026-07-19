// Role-based access control: AWS-IAM-style "resource:action" permissions
// grouped into roles. Routes declare the permission they need; the authorize
// decorator checks it against the caller's role.

export const PERMISSIONS = Object.freeze({
    INCIDENTS_READ: "incidents:read",
    INCIDENTS_CREATE: "incidents:create",
    INCIDENTS_DELETE: "incidents:delete",
    EVIDENCE_UPLOAD: "evidence:upload",
    ANALYSIS_RUN: "analysis:run",
    REPORTS_READ: "reports:read",
    GRAPH_READ: "graph:read",
    GRAPH_WRITE: "graph:write",
    RUNBOOKS_READ: "runbooks:read",
    KNOWLEDGE_READ: "knowledge:read",     // search the RAG knowledge base
    KNOWLEDGE_WRITE: "knowledge:write",   // ingest/delete knowledge-base docs
    INCIDENT_CHAT: "incident:chat",       // ask the AI copilot (invokes the LLM, writes the transcript)
    REALTIME_SUBSCRIBE: "realtime:subscribe",
    MEMBERS_READ: "org:members:read",
    MEMBERS_INVITE: "org:members:invite",
    MEMBERS_MANAGE: "org:members:manage",   // change roles, remove members
    ORG_MANAGE: "org:manage",               // rename/delete org, transfer ownership
});

const VIEWER = [
    PERMISSIONS.INCIDENTS_READ,
    PERMISSIONS.REPORTS_READ,
    PERMISSIONS.GRAPH_READ,
    PERMISSIONS.RUNBOOKS_READ,
    PERMISSIONS.KNOWLEDGE_READ,
    PERMISSIONS.REALTIME_SUBSCRIBE,
    PERMISSIONS.MEMBERS_READ,
];

const MEMBER = [
    ...VIEWER,
    PERMISSIONS.INCIDENTS_CREATE,
    PERMISSIONS.EVIDENCE_UPLOAD,
    PERMISSIONS.ANALYSIS_RUN,
    PERMISSIONS.GRAPH_WRITE,
    PERMISSIONS.KNOWLEDGE_WRITE,
    PERMISSIONS.INCIDENT_CHAT,
];

const ADMIN = [
    ...MEMBER,
    PERMISSIONS.INCIDENTS_DELETE,
    PERMISSIONS.MEMBERS_INVITE,
    PERMISSIONS.MEMBERS_MANAGE,
];

const OWNER = [
    ...ADMIN,
    PERMISSIONS.ORG_MANAGE,
];

export const ROLES = Object.freeze({
    viewer: Object.freeze(new Set(VIEWER)),
    member: Object.freeze(new Set(MEMBER)),
    admin: Object.freeze(new Set(ADMIN)),
    owner: Object.freeze(new Set(OWNER)),
});

// used to stop privilege escalation: you may only grant roles strictly
// below your own rank (owners can grant owner via explicit transfer)
export const ROLE_RANK = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });

export const ASSIGNABLE_ROLES = Object.freeze(["viewer", "member", "admin"]);

export function roleHasPermission(role, permission) {
    const set = ROLES[role];
    return !!set && set.has(permission);
}