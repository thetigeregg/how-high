import type { FastifyInstance } from "fastify";

export function registerHealthRoute(app: FastifyInstance) {
  app.get("/api/health", async (_request, reply) => {
    try {
      app.db.prepare("SELECT 1").get();
      return { status: "ok" };
    } catch {
      return reply.status(503).send({ status: "error" });
    }
  });
}
