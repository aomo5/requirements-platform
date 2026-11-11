"use strict";
const { WorkbenchClient, CliError, localOrigin } = require("./workbench-cli-client");
class DesignClient extends WorkbenchClient {
  bundle(entryPath) { return this.request("/api/design/bundle?" + new URLSearchParams({ path: entryPath })); }
  apply(entryPath, payload, dryRun = false) {
    return this.request("/api/design/batch?" + new URLSearchParams({ path: entryPath }), {
      method: "POST", body: { ...payload, ...(dryRun ? { dryRun: true } : {}) },
    });
  }
  export(entryPath, payload) {
    return this.request("/api/design/export?" + new URLSearchParams({ path: entryPath }), {
      method: "POST", body: payload, binary: true, timeoutMs: 90000,
    });
  }
}
module.exports = { DesignClient, CliError, localOrigin };
