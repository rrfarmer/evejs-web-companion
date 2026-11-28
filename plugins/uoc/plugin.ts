import { definePlugin } from "../../web/src/plugin-api/index.ts";

export default definePlugin({
  id: "uoc",
  name: "Unified Operations Center",
  version: "0.1.0",
  apiVersion: 1,
  description: "Mining, combat, pilot training and ship provisioning operations.",
  label: "UOC",
  glyph: ["M3 20h18L12 4z", "M12 9v7m-4 0h8"],
  page: {},
  backend: "backend.ts",
});
