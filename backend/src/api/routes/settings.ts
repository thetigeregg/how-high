import type { FastifyInstance } from "fastify";
import { fitAgainstMarks, refreshAll } from "../../hikes.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, settingsSchema } from "../../settings.js";

export function registerSettingsRoute(app: FastifyInstance) {
  const respond = async () => {
    const settings = loadSettings(app.db);
    return { settings, defaults: DEFAULT_SETTINGS, fit: await fitAgainstMarks(app.db, settings) };
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
}
