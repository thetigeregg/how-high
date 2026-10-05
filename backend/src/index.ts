import { buildServer } from "./api/server.js";
import { config } from "./config.js";
import { openDatabase } from "./db/client.js";
import { refreshAll } from "./hikes.js";
import { logger } from "./logger.js";

const db = openDatabase();
const app = buildServer(db);

app
  .listen({ host: "0.0.0.0", port: config.port })
  .then(() => {
    logger.info({ port: config.port }, "server listening");
    // Hikes stored by an older version are measured again in the background.
    void refreshAll(db);
  })
  .catch((err) => {
    logger.error({ err }, "failed to start server");
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    app.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
