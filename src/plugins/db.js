import fp from "fastify-plugin";
import {db} from "../db/Client.js";
async function dbPlugin(fastify){
    fastify.decorate("db",db);
      console.log("DB plugin loaded");
}
export default fp(dbPlugin, { name: "db-plugin" });