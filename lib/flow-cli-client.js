"use strict";
const { WorkbenchClient, CliError, localOrigin } = require("./workbench-cli-client");
class FlowClient extends WorkbenchClient {
  bundle(entryPath) { return this.request("/api/flows/bundle?" + new URLSearchParams({ path: entryPath })); }
  apply(entryPath, payload, dryRun = false) {
    return this.request("/api/flows/batch?" + new URLSearchParams({ path: entryPath }), {
      method: "POST", body: { ...payload, ...(dryRun ? { dryRun: true } : {}) },
    });
  }
}
module.exports = { FlowClient, CliError, localOrigin };
