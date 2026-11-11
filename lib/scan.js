"use strict";

const fs = require("fs");
const path = require("path");
const { getFlowSummary } = require("./flow-store");

const MODULE_DIR_PATTERN = /^\d{2}-/;
const SPEC_FILE_NAME = "规格索引.md";
const REQUIREMENT_FILE_NAME = "需求文档.md";
const CONTRACT_FILE_NAME = "接口契约.md";
const PROTOTYPE_DIR_NAME = "原型设计";
const PREVIEW_FILE_PATTERN = /\.(html?|png|jpe?g|webp|svg)$/i;
const DOCUMENT_FILE_PATTERN = /\.md$/i;
const DESIGN_FILE_NAME = "设计工作台.json";
const MAX_DESIGN_BYTES = 4 * 1024 * 1024;

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function readJsonIfExists(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallbackValue;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    return null;
  }
}

function getFileUpdatedAt(filePath) {
  const stat = safeStat(filePath);
  return stat?.isFile() ? stat.mtime.toISOString() : null;
}

function readTextIfExists(filePath) {
  if (!safeStat(filePath)?.isFile()) {
    return "";
  }

  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return "";
  }
}

function getIssueIdentFromText(rawText) {
  const lines = String(rawText || "").split(/\r?\n/).slice(0, 60);
  const preferredLinePatterns = [
    /需求编号/i,
    /Gitee.*(?:需求|工作项|需求事项|需求单|项目同步)/i,
    /来源需求/i,
  ];

  for (const linePattern of preferredLinePatterns) {
    const matchLine = lines.find((line) => linePattern.test(line) && /\bI[A-Z0-9]{5}\b/.test(line));
    if (matchLine) {
      return matchLine.match(/\bI[A-Z0-9]{5}\b/)?.[0] || "";
    }
  }

  return "";
}

function getGiteeStatus(entryDir, relativePath, statusMap, sources = {}) {
  const mappedIdent = statusMap.paths?.[relativePath];
  const specText = sources.specText ?? readTextIfExists(path.join(entryDir, SPEC_FILE_NAME));
  const requirementText = sources.requirementText ?? readTextIfExists(path.join(entryDir, REQUIREMENT_FILE_NAME));
  const ident = mappedIdent || getIssueIdentFromText(specText) || getIssueIdentFromText(requirementText);

  if (!ident) {
    return {
      ident: null,
      label: "未关联",
      state: "unlinked",
      url: null,
      updatedAt: null,
    };
  }

  const issue = statusMap.issues?.[ident];
  const enterprisePath = statusMap.program?.enterprisePath;
  const issueUrl = /^[a-zA-Z0-9_-]+$/.test(enterprisePath || "")
    ? `https://gitee.com/enterprises/${enterprisePath}/issues/${encodeURIComponent(ident)}` : null;
  if (!issue) {
    return {
      ident,
      label: "待同步",
      state: "unsynced",
      url: issueUrl,
      updatedAt: null,
    };
  }

  return {
    ident,
    label: statusMap.stateLabels?.[issue.state] || issue.state || "待同步",
    state: issue.state || "unsynced",
    title: issue.title || "",
    assignee: issue.assignee || "",
    url: issue.url || issueUrl,
    updatedAt: issue.updatedAt || null,
  };
}

function getPreviewType(fileName) {
  return /\.html?$/i.test(fileName) ? "html" : "image";
}

function getPrototypeFiles(prototypeDir, requirementsRoot) {
  if (!fs.existsSync(prototypeDir)) {
    return [];
  }

  return fs
    .readdirSync(prototypeDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && PREVIEW_FILE_PATTERN.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    .map((entry) => {
      const fullPath = path.join(prototypeDir, entry.name);
      const relativePath = toPosixPath(path.relative(requirementsRoot, fullPath));
      return {
        name: entry.name,
        path: relativePath,
        previewUrl: `/preview/${encodeURI(relativePath)}`,
        type: getPreviewType(entry.name),
        updatedAt: getFileUpdatedAt(fullPath),
      };
    });
}

function getPageDesignFiles(pageDesignDir, requirementsRoot) {
  if (!fs.existsSync(pageDesignDir)) {
    return [];
  }

  return fs
    .readdirSync(pageDesignDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && DOCUMENT_FILE_PATTERN.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    .map((entry) => {
      const fullPath = path.join(pageDesignDir, entry.name);
      return {
        name: entry.name,
        path: toPosixPath(path.relative(requirementsRoot, fullPath)),
        updatedAt: getFileUpdatedAt(fullPath),
      };
    });
}

function getDesignSummary(prototypeDir, requirementsRoot) {
  const filePath = path.join(prototypeDir, DESIGN_FILE_NAME);
  try {
    const relative = path.relative(requirementsRoot, filePath);
    let cursor = requirementsRoot;
    for (const part of relative.split(path.sep)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_DESIGN_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (data.schemaVersion !== 1 || !Number.isInteger(data.revision) || data.revision < 1
      || !Array.isArray(data.pages) || data.pages.length > 100) return null;
    const ids = new Set();
    const pages = data.pages.map((page) => {
      if (!page || typeof page.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(page.id) || ids.has(page.id)
        || typeof page.name !== "string" || !page.name.trim() || page.name.length > 100
        || !Number.isInteger(page.width) || page.width < 240 || page.width > 2560
        || !Number.isInteger(page.height) || page.height < 200 || page.height > 6000
        || (page.route && (typeof page.route !== "string" || !page.route.startsWith("#") || page.route.length > 500))) throw new Error("Invalid design summary");
      ids.add(page.id);
      return { id: page.id, name: page.name, width: page.width, height: page.height, route: page.route || "" };
    });
    const updatedAt = typeof data.updatedAt === "string" && Number.isFinite(Date.parse(data.updatedAt))
      ? data.updatedAt : stat.mtime.toISOString();
    return { revision: data.revision, updatedAt, pages };
  } catch {
    // A damaged design remains available for diagnosis through the design API.
    return null;
  }
}

function buildEntry(entryDir, requirementsRoot, linkMap, statusMap) {
  const relativePath = toPosixPath(path.relative(requirementsRoot, entryDir));
  const segments = relativePath.split("/").filter(Boolean);
  const moduleName = segments[0] || "";
  const featureName = segments[segments.length - 1] || path.basename(entryDir);
  const specPath = path.join(entryDir, SPEC_FILE_NAME);
  const requirementPath = path.join(entryDir, REQUIREMENT_FILE_NAME);
  const contractPath = path.join(entryDir, CONTRACT_FILE_NAME);
  const prototypeDir = path.join(entryDir, PROTOTYPE_DIR_NAME);
  const pageDesignDir = path.join(entryDir, "页面设计");

  const specExists = Boolean(safeStat(specPath)?.isFile());
  const requirementExists = Boolean(safeStat(requirementPath)?.isFile());
  const contractExists = Boolean(safeStat(contractPath)?.isFile());
  const prototypes = getPrototypeFiles(prototypeDir, requirementsRoot);
  const pageDesigns = getPageDesignFiles(pageDesignDir, requirementsRoot);
  const design = getDesignSummary(prototypeDir, requirementsRoot);
  const flow = getFlowSummary(entryDir, requirementsRoot);
  // Keep a damaged flow-only requirement discoverable so the catalog can report it.
  const flowExists = Boolean(safeStat(path.join(entryDir, "流程设计", "流程工作台.json"))?.isFile());

  if (!specExists && !requirementExists && !contractExists && prototypes.length === 0 && pageDesigns.length === 0 && !design && !flowExists) {
    return null;
  }

  const updatedCandidates = [
    specExists ? safeStat(specPath)?.mtimeMs : 0,
    requirementExists ? safeStat(requirementPath)?.mtimeMs : 0,
    contractExists ? safeStat(contractPath)?.mtimeMs : 0,
    ...prototypes.map((item) => (item.updatedAt ? new Date(item.updatedAt).getTime() : 0)),
    ...pageDesigns.map((item) => (item.updatedAt ? new Date(item.updatedAt).getTime() : 0)),
    design?.updatedAt ? new Date(design.updatedAt).getTime() : 0,
    flow?.updatedAt ? new Date(flow.updatedAt).getTime() : 0,
  ].filter(Boolean);
  const updatedAt = updatedCandidates.length ? new Date(Math.max(...updatedCandidates)).toISOString() : null;

  return {
    module: moduleName,
    feature: featureName,
    path: relativePath,
    updatedAt,
    writingStatus: {
      state: requirementExists ? "ready" : "missing",
      label: requirementExists ? "需求已写" : "待写需求",
    },
    gitee: getGiteeStatus(entryDir, relativePath, statusMap),
    docs: {
      spec: specExists ? toPosixPath(path.relative(requirementsRoot, specPath)) : null,
      requirement: requirementExists ? toPosixPath(path.relative(requirementsRoot, requirementPath)) : null,
      contract: contractExists ? toPosixPath(path.relative(requirementsRoot, contractPath)) : null,
    },
    pageDesigns,
    prototypes,
    design,
    flow,
    relatedRoutes: Array.isArray(linkMap[relativePath]) ? linkMap[relativePath] : [],
  };
}

function walkForEntries(currentDir, requirementsRoot, linkMap, statusMap, collector) {
  const dirents = fs.readdirSync(currentDir, { withFileTypes: true });
  const entry = buildEntry(currentDir, requirementsRoot, linkMap, statusMap);
  if (entry) {
    collector.push(entry);
  }

  dirents
    .filter((dirent) => dirent.isDirectory())
    .forEach((dirent) => {
      if (dirent.name === "portal" || dirent.name === PROTOTYPE_DIR_NAME || dirent.name === "页面设计" || dirent.name === "流程设计" || dirent.name.startsWith(".")) {
        return;
      }
      walkForEntries(path.join(currentDir, dirent.name), requirementsRoot, linkMap, statusMap, collector);
    });
}

function scanRequirements(requirementsRoot, options = {}) {
  const linkMapPath = options.linkMapPath || path.join(requirementsRoot, "portal", "data", "link-map.json");
  const statusMapPath = options.statusMapPath || path.join(requirementsRoot, "portal", "data", "gitee-status.json");
  const linkMap = readJsonIfExists(linkMapPath, {});
  const statusMap = readJsonIfExists(statusMapPath, {});
  const modules = fs
    .readdirSync(requirementsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && MODULE_DIR_PATTERN.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

  const entries = [];
  modules.forEach((moduleDir) => {
    walkForEntries(path.join(requirementsRoot, moduleDir.name), requirementsRoot, linkMap, statusMap, entries);
  });

  const moduleTree = modules.map((moduleDir) => {
    const features = entries
      .filter((entry) => entry.module === moduleDir.name)
      .sort((left, right) => {
        const updatedDiff = new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime();
        return updatedDiff || left.path.localeCompare(right.path, "zh-CN");
      });

    return {
      module: moduleDir.name,
      path: toPosixPath(moduleDir.name),
      featureCount: features.length,
      features,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    giteeStatusSyncedAt: statusMap.syncedAt || null,
    root: requirementsRoot,
    latestEntryPath: entries
      .slice()
      .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime())[0]?.path || "",
    modules: moduleTree,
  };
}

function findEntryByPath(tree, relativePath) {
  for (const moduleNode of tree.modules) {
    const match = moduleNode.features.find((feature) => feature.path === relativePath);
    if (match) {
      return match;
    }
  }
  return null;
}

module.exports = {
  findEntryByPath,
  getGiteeStatus,
  scanRequirements,
  toPosixPath,
};
