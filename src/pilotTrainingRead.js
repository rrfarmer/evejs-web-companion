"use strict";

function trainingError(code, message = code, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

module.exports = { trainingError };
