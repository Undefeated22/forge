import { incidents } from "../../db/schema.js";
export async function createIncident(db, data){
    const result = await db.insert(incidents).values({
        title: data.title,
        description: data.description,
        userId: data.userId,
        tenantId: data.tenantId
    }).returning();
    return result[0]
}