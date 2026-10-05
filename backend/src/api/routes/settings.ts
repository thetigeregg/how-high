import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fitAgainstMarks, refreshAll } from "../../hikes.js";
import {
  DEFAULT_SETTINGS,
  hasPreviousSettings,
  loadSettings,
  replaceSettings,
  revertSettings,
  saveSettings,
  settingsSchema,
} from "../../settings.js";
import { suggest } from "../../suggest.js";

export function registerSettingsRoute(app: FastifyInstance) {
  const respond = async () => {
    const settings = loadSettings(app.db);
    return {
      settings,
      defaults: DEFAULT_SETTINGS,
      fit: await fitAgainstMarks(app.db, settings),
      // Whether an applied suggestion can still be undone.
      canRevert: hasPreviousSettings(app.db),
    };
  };

  app.get("/api/settings", respond);

  // Replaces all settings. Hikes are re-scored before this returns, and
  // measured again first if a measurement setting changed.
  app.put("/api/settings", async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid settings", details: parsed.error.flatten() });
    }
    saveSettings(app.db, parsed.data);
    await refreshAll(app.db, parsed.data);
    return respond();
  });

  // Works out settings that fit the marks better and what they would change. Saves nothing.
  app.post("/api/settings/suggest", async (request, reply) => {
    const parsed = z.object({ profile: z.enum(["hike", "road"]) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid body" });
    return suggest(app.db, parsed.data.profile);
  });

  // Saves a suggestion the user has confirmed, keeping the present settings to go back to.
  app.post("/api/settings/apply", async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid settings", details: parsed.error.flatten() });
    }
    replaceSettings(app.db, parsed.data);
    await refreshAll(app.db, parsed.data);
    return respond();
  });

  app.post("/api/settings/revert", async (_request, reply) => {
    if (!revertSettings(app.db)) return reply.status(409).send({ error: "there are no previous settings to go back to" });
    await refreshAll(app.db);
    return respond();
  });
}
