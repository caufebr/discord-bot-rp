import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/index.js";

process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException — process kept alive");
});

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandledRejection — process kept alive");
});

const rawPort = process.env["PORT"];
const port = rawPort ? Number(rawPort) : 3000;

if (Number.isNaN(port) || port <= 0) {
  logger.warn({ rawPort }, "Invalid PORT value, skipping HTTP server");
} else {
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port — continuing without HTTP");
      return;
    }
    logger.info({ port }, "Server listening");
  });
}

startBot().catch((err) => {
  logger.error({ err }, "Failed to start Discord bot");
});
