import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { applyImport, buildExport, previewImport, readExport, type ExportFile } from "../../transfer.js";

export function registerTransferRoute(app: FastifyInstance) {
  /** The uploaded export file, checked; or a message saying why it cannot be used. */
  async function uploaded(request: FastifyRequest): Promise<ExportFile | string> {
    const upload = await request.file({ limits: { fileSize: config.maxImportBytes } });
    if (!upload) return "no file uploaded";
    const buffer = await upload.toBuffer().catch(() => null);
    if (!buffer || upload.file.truncated) return "that file is too large to import";
    try {
      return readExport(buffer);
    } catch (err) {
      return (err as Error).message;
    }
  }

  app.get("/api/export", async (_request, reply) => {
    const name = `how-high-${new Date().toISOString().slice(0, 10)}.json.gz`;
    return reply
      .header("Content-Type", "application/gzip")
      .header("Content-Disposition", `attachment; filename="${name}"`)
      .send(buildExport(app.db));
  });

  // What the file holds and what importing it would do. Changes nothing.
  app.post("/api/import/preview", async (request, reply) => {
    const data = await uploaded(request);
    if (typeof data === "string") return reply.status(400).send({ error: data });
    return previewImport(app.db, data);
  });

  app.post("/api/import", async (request, reply) => {
    const query = z
      .object({ mode: z.enum(["merge", "replace"]), settings: z.enum(["0", "1"]).default("1") })
      .safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "choose how to import: merge or replace" });
    const data = await uploaded(request);
    if (typeof data === "string") return reply.status(400).send({ error: data });
    return applyImport(app.db, data, { mode: query.data.mode, settings: query.data.settings === "1" });
  });
}
