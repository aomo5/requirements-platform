# 外部接入

## Gitee 企业版

在 MySQL 模式的 `.env` 中加入 `GITEE_SYNC_ENABLED=true`。维护者先通过本机的工作台「设置」填写企业、项目和 API 凭据，再启用团队账号模式。同步前可以比较本地和远端版本，明确选择拉取、推送或新建。同步凭据写入 `.secrets/`，也可由维护者通过 `GITEE_SECRET_FILE` 指定文件。

## Apifox

在 MySQL 模式下安装 Apifox CLI，由运行工作台的账号完成 CLI 登录。在 `.env` 中将 `APIFOX_CLI_PATH` 指向 CLI 的 `bin/cli.js`，将受控环境写入 `.secrets/apifox-executor.json`。配置路径可通过 `APIFOX_EXECUTOR_CONFIG` 修改。

```json
{
  "environments": [
    {
      "id": "demo",
      "name": "示例预检",
      "scope": "preflight",
      "apifoxId": "100",
      "ready": false,
      "allowedResources": ["101:102:scenario:103"]
    }
  ]
}
```

用自己的测试项目、分支、资源和环境 ID 替换示例值，确认资源后将 `ready` 改为 `true`。`allowedResources` 使用 `项目ID:分支ID:资源类型:资源ID` 格式。类型包括 `case`、`scenario`、`suite`。

业务执行使用 `scope: "business"`、专用 `database` 和 `expectedScenarios`，需要自行部署本机业务驱动。`preflightUrl` 指向回环地址的 `/pilot/preflight`。它返回 `ready`、`resourcesConfirmed`、`masterDatabase`、`slaveDatabase`、`codeVersion` 和 `serviceVersion`。`evidenceUrl` 指向回环地址的 `/pilot/runs/`，工作台追加运行 ID 并读取本次 `{runId, results}`。每个预期场景须对应一条实际执行结果，包含 `scenario`、`runId`、`database`、`executed` 和 `cleanupCompleted`。配置、前置检查和执行证据的数据库必须一致。业务驱动和业务用例由接入方维护。
