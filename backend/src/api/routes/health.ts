import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";

export function registerHealthRoute(app: FastifyInstance) {
  // Which optional features this installation has.
  app.get("/api/meta", async () => ({ googleMaps: config.googleMapsApiKey !== null }));

  app.get("/api/health", async (_request, reply) => {
    try {
      app.db.prepare("SELECT 1").get();
      return { status: "ok" };
    } catch {
      return reply.status(503).send({ status: "error" });
    }
  });
}
