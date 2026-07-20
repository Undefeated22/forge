// A malformed id in the URL is a client mistake, and the API has to say so
// itself — otherwise the string travels all the way to Postgres, which rejects
// it with `invalid input syntax for type uuid` and Fastify reports that as a
// 500. Three routes were confirmed doing exactly that (evidence upload, analyze,
// fetch report): a caller typo read as a server fault, with a stack trace in the
// logs for something that never should have reached the database.
//
// `encryptedEvidence.routes.js` already hand-rolled this guard with a regex and
// a manual 400. This is the same check as a schema, so the other routes get it
// without each one restating it.
//
// Deliberately NOT applied globally by param name: `/graph/blast-radius/:nodeId`
// takes a component name ("payment-gateway") and `/ingest/:slug` a slug, so a
// blanket "every :xxxId is a uuid" hook would reject valid requests.

/** Fastify params schema requiring each named path param to be a UUID. */
export function uuidParams(...names) {
    return {
        type: "object",
        required: names,
        properties: Object.fromEntries(
            names.map((n) => [n, { type: "string", format: "uuid" }])
        ),
    };
}
