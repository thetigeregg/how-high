import path from "node:path";

const dataDir = process.env.DATA_DIR ?? "/data";

export const config = {
  dataDir,
  demDir: path.join(dataDir, "dem"),
};
