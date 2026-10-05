import multipart from "@fastify/multipart";
import Fastify from "fastify";
import type Database from "better-sqlite3";
import { config } from "../config.js";
import { registerAnalysesRoute } from "./routes/analyses.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerSettingsRoute } from "./routes/settings.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Database.Database;
  }
}

export function buildServer(db: Database.Database) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : { target: "pino-pretty", options: { colorize: true } },
    },
  });
  app.decorate("db", db);
  app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });

  registerHealthRoute(app);
  registerAnalysesRoute(app);
  registerSettingsRoute(app);

  return app;
}
