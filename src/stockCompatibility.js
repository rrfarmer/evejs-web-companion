"use strict";
function unavailable(code, message) {
  throw Object.assign(new Error(message), { code, statusCode: 409 });
}
const structureServices = () => unavailable("STRUCTURE_SERVICE_AUTHORITY_UNAVAILABLE",
  "Stock EveJS web gateway does not expose authoritative structure services. This action requires service authority; NPC station actions remain available.");
module.exports = { unavailable, structureServices };
