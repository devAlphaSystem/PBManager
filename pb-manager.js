#!/usr/bin/env node

import { program } from "commander";
import inquirer from "inquirer";
import fs from "fs-extra";
import path from "node:path";
import { createSession, get as nlcurlGet, request as nlcurlRequest } from "nlcurl";
import chalk from "chalk";
import unzipper from "unzipper";
import shell from "shelljs";
import os from "node:os";
import dns from "node:dns/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import tls from "node:tls";

const PM2_INSTANCE_PREFIX = "pb-";
const PM2_STATUS_ONLINE = "online";
const POCKETBASE_FALLBACK_VERSION = "0.36.0";
const CLI_CONFIG_FILE = "cli-config.json";
const INSTANCES_CONFIG_FILE = "instances.json";
const POCKETBASE_BIN_SUBDIR = "bin";
const POCKETBASE_EXEC_NAME = "pocketbase";
const INSTANCES_DATA_SUBDIR = "instances_data";
const PM2_ECOSYSTEM_FILENAME = "ecosystem.config.js";
const VERSION_CACHE_FILENAME = "version-cache.json";
const GITHUB_API_POCKETBASE_RELEASES = "https://api.github.com/repos/pocketbase/pocketbase/releases/latest";
const IPFY_URL = "https://api.ipify.org?format=json";
const PB_MANAGER_UPDATE_SCRIPT_URL_BASE = "https://raw.githubusercontent.com/devAlphaSystem/Alpha-System-PBManager/main/";
const PB_MANAGER_SCRIPT_NAME = "pb-manager.js";
const DEFAULT_INSTALL_PATH_PB_MANAGER = "/opt/pb-manager/pb-manager.js";
const POCKETBASE_DOWNLOAD_LOCK_FILENAME = ".download.lock";
const VERSION_CACHE_TTL = 86400000;
const HTTP_TIMEOUT = 5000;
const TLS_TIMEOUT = 4500;

const NGINX_GLOBAL_CONF_PATH = "/etc/nginx/nginx.conf";
let NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
let NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";
let NGINX_DISTRO_MODE = "debian";

const pbManagerVersion = "0.9.2";

const VERSION_REGEX = /^\d+\.\d+\.\d+$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_REGEX = /^[a-zA-Z0-9-]+$/;
const SIZE_REGEX = /^\d+(M|G|m|g)$/;
const IP_REGEX = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const WHITESPACE_REGEX = /^(\s*)/;

const nlcurlSession = createSession({
  timeout: HTTP_TIMEOUT,
  headers: { "User-Agent": "pb-manager" },
  maxRedirects: 5,
});

async function safeRunCommand(command, args, errorMessage, ignoreError = false, options = {}) {
  return new Promise((resolve, reject) => {
    if (completeLogging) {
      console.log(chalk.yellow(`Executing: ${command} ${args.join(" ")}`));
    }

    const isSilent = options.silent;
    const effectiveOptions = {
      stdio: completeLogging && !isSilent ? "inherit" : "pipe",
      shell: false,
      ...options,
    };

    const proc = spawn(command, args, effectiveOptions);

    const stdoutChunks = [];
    const stderrChunks = [];

    if (proc.stdout) {
      proc.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    }
    if (proc.stderr) {
      proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    }

    proc.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();

      if (code !== 0 && !ignoreError) {
        const fullErrorMsg = errorMessage || `Error executing command: ${command} ${args.join(" ")}`;
        if (completeLogging || !isSilent) {
          console.error(chalk.red(stderr || stdout));
        }
        const error = new Error(`${fullErrorMsg} - Exit Code: ${code} - Stderr: ${stderr.trim()} - Stdout: ${stdout.trim()}`);
        error.exitCode = code;
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
      } else {
        resolve({ code, stdout, stderr });
      }
    });

    proc.on("error", (err) => {
      const fullErrorMsg = errorMessage || `Failed to start command: ${command}`;
      const error = new Error(`${fullErrorMsg} - OS Error: ${err.message}`);
      error.osError = err;
      reject(error);
    });
  });
}

async function detectDistro() {
  const hasApt = shell.which("apt-get");
  const hasDnf = !hasApt && shell.which("dnf");
  const hasPacman = !hasApt && !hasDnf && shell.which("pacman");

  if (hasApt) {
    NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
    NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";
    NGINX_DISTRO_MODE = "debian";
    await Promise.all([fs.existsSync(NGINX_SITES_AVAILABLE) ? Promise.resolve() : safeRunCommand("sudo", ["mkdir", "-p", NGINX_SITES_AVAILABLE], "Failed to create Nginx sites-available directory", true).catch(() => {}), fs.existsSync(NGINX_SITES_ENABLED) ? Promise.resolve() : safeRunCommand("sudo", ["mkdir", "-p", NGINX_SITES_ENABLED], "Failed to create Nginx sites-enabled directory", true).catch(() => {})]);
    return "apt";
  }

  if (hasDnf) {
    NGINX_SITES_AVAILABLE = "/etc/nginx/conf.d";
    NGINX_SITES_ENABLED = "/etc/nginx/conf.d";
    NGINX_DISTRO_MODE = "rhel";
    if (!fs.existsSync(NGINX_SITES_AVAILABLE)) {
      await safeRunCommand("sudo", ["mkdir", "-p", NGINX_SITES_AVAILABLE], "Failed to create Nginx conf.d directory", true).catch(() => {});
    }
    return "dnf";
  }

  if (hasPacman) {
    NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
    NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";
    NGINX_DISTRO_MODE = "arch";
    await Promise.all([fs.existsSync(NGINX_SITES_AVAILABLE) ? Promise.resolve() : safeRunCommand("sudo", ["mkdir", "-p", NGINX_SITES_AVAILABLE], "Failed to create Nginx sites-available directory", true).catch(() => {}), fs.existsSync(NGINX_SITES_ENABLED) ? Promise.resolve() : safeRunCommand("sudo", ["mkdir", "-p", NGINX_SITES_ENABLED], "Failed to create Nginx sites-enabled directory", true).catch(() => {})]);
    return "pacman";
  }
  return null;
}

const HOME_DIR = process.env.HOME || os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, ".pb-manager");
const CLI_CONFIG_PATH = path.join(CONFIG_DIR, CLI_CONFIG_FILE);
const INSTANCES_CONFIG_PATH = path.join(CONFIG_DIR, INSTANCES_CONFIG_FILE);
const POCKETBASE_BIN_DIR = path.join(CONFIG_DIR, POCKETBASE_BIN_SUBDIR);
const POCKETBASE_EXEC_PATH = path.join(POCKETBASE_BIN_DIR, POCKETBASE_EXEC_NAME);
const INSTANCES_DATA_BASE_DIR = path.join(CONFIG_DIR, INSTANCES_DATA_SUBDIR);
const PM2_ECOSYSTEM_FILE = path.join(CONFIG_DIR, PM2_ECOSYSTEM_FILENAME);
const VERSION_CACHE_PATH = path.join(CONFIG_DIR, VERSION_CACHE_FILENAME);
const POCKETBASE_DOWNLOAD_LOCK_PATH = path.join(POCKETBASE_BIN_DIR, POCKETBASE_DOWNLOAD_LOCK_FILENAME);

let completeLogging = false;
let _latestPocketBaseVersionCache = null;

let _cliConfigCache = null;
let _instancesConfigCache = null;
let _instancesConfigMtime = 0;

async function validateDnsRecords(domain) {
  try {
    const [publicIpRes, aRecordsResult, aaaaRecordsResult] = await Promise.allSettled([nlcurlSession.get(IPFY_URL), dns.resolve4(domain), dns.resolve6(domain)]);

    if (publicIpRes.status !== "fulfilled" || !publicIpRes.value?.json()?.ip) {
      console.log(chalk.yellow("Could not fetch server's public IP. Skipping DNS validation."));
      return true;
    }

    const serverIp = publicIpRes.value.json().ip;
    let domainResolved = false;
    let pointsToServer = false;

    if (aRecordsResult.status === "fulfilled") {
      const aRecords = aRecordsResult.value;
      domainResolved = true;
      pointsToServer = aRecords.includes(serverIp);
    } else if (completeLogging) {
      console.log(chalk.blue(`No A records found or error resolving A records for ${domain}: ${aRecordsResult.reason?.message}`));
    }

    if (!pointsToServer && aaaaRecordsResult.status === "fulfilled") {
      const aaaaRecords = aaaaRecordsResult.value;
      domainResolved = domainResolved || aaaaRecords.length > 0;
      pointsToServer = aaaaRecords.includes(serverIp);
    } else if (!pointsToServer && completeLogging && aaaaRecordsResult.status === "rejected") {
      console.log(chalk.blue(`No AAAA records found or error resolving AAAA records for ${domain}: ${aaaaRecordsResult.reason?.message}`));
    }

    if (!domainResolved) {
      console.log(chalk.red(`Domain ${domain} could not be resolved. It might not exist or DNS propagation is pending.`));
      return false;
    }
    if (!pointsToServer) {
      console.log(chalk.yellow(`Domain ${domain} exists but does not seem to point to this server's IP (${serverIp}). Please check your DNS A/AAAA records.`));
    }
    return pointsToServer;
  } catch (e) {
    console.log(chalk.red(`Error validating DNS records for ${domain}: ${e.message}`));
    return false;
  }
}

async function getCachedLatestVersion() {
  const now = Date.now();
  try {
    if (await fs.pathExists(VERSION_CACHE_PATH)) {
      const cache = await fs.readJson(VERSION_CACHE_PATH).catch(() => null);
      if (cache?.timestamp && cache?.latestVersion && now - cache.timestamp < VERSION_CACHE_TTL) {
        return cache.latestVersion;
      }
    }
    const latestVersion = await getLatestPocketBaseVersion(true);
    fs.ensureDir(path.dirname(VERSION_CACHE_PATH))
      .then(() => fs.writeJson(VERSION_CACHE_PATH, { timestamp: now, latestVersion }))
      .catch(() => {});
    return latestVersion;
  } catch (e) {
    if (completeLogging) {
      console.log(chalk.yellow(`Error with version cache: ${e.message}. Fetching directly.`));
    }
    return getLatestPocketBaseVersion(false);
  }
}

async function getLatestPocketBaseVersion(forceRefresh = false) {
  if (_latestPocketBaseVersionCache && !forceRefresh) {
    return _latestPocketBaseVersionCache;
  }
  try {
    const res = await nlcurlSession.get(GITHUB_API_POCKETBASE_RELEASES);
    if (res.json()?.tag_name) {
      _latestPocketBaseVersionCache = res.json().tag_name.replace(/^v/, "");
      return _latestPocketBaseVersionCache;
    }
    if (completeLogging) {
      console.warn(chalk.yellow(`Could not determine latest PocketBase version from GitHub API response. Using fallback ${POCKETBASE_FALLBACK_VERSION}.`));
    }
  } catch (e) {
    if (completeLogging) {
      console.error(chalk.red(`Failed to fetch latest PocketBase version from GitHub: ${e.message}. Using fallback version ${POCKETBASE_FALLBACK_VERSION}.`));
    }
  }
  _latestPocketBaseVersionCache = POCKETBASE_FALLBACK_VERSION;
  return _latestPocketBaseVersionCache;
}

async function getInstalledPocketBaseVersion() {
  if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
    return null;
  }
  try {
    const { stdout } = await safeRunCommand(POCKETBASE_EXEC_PATH, ["--version"], "Failed to get PocketBase version", false, { silent: true });
    const version = stdout.trim();
    return VERSION_REGEX.test(version) ? version : null;
  } catch {
    return null;
  }
}

async function getCliConfig() {
  if (_cliConfigCache) return _cliConfigCache;

  const defaults = {
    defaultCertbotEmail: null,
    completeLogging: false,
  };

  if (await fs.pathExists(CLI_CONFIG_PATH)) {
    try {
      const config = await fs.readJson(CLI_CONFIG_PATH);
      _cliConfigCache = { ...defaults, ...config };
      return _cliConfigCache;
    } catch (e) {
      if (completeLogging) {
        console.warn(chalk.yellow("Could not read CLI config, using defaults."));
      }
    }
  }
  _cliConfigCache = defaults;
  return _cliConfigCache;
}

async function saveCliConfig(config) {
  _cliConfigCache = config;
  await fs.ensureDir(CONFIG_DIR);
  await fs.writeJson(CLI_CONFIG_PATH, config, { spaces: 2, mode: 0o600 });
}

async function ensureBaseSetup() {
  await Promise.all([fs.ensureDir(CONFIG_DIR).then(() => fs.chmod(CONFIG_DIR, 0o700).catch(() => {})), fs.ensureDir(POCKETBASE_BIN_DIR), fs.ensureDir(INSTANCES_DATA_BASE_DIR)]);

  await Promise.all([fs.pathExists(INSTANCES_CONFIG_PATH).then((exists) => (exists ? null : fs.writeJson(INSTANCES_CONFIG_PATH, { instances: {} }, { mode: 0o600 }))), fs.pathExists(PM2_ECOSYSTEM_FILE).then((exists) => (exists ? null : fs.writeFile(PM2_ECOSYSTEM_FILE, "module.exports = { apps: [] };")))]);

  const currentCliConfig = await getCliConfig();
  await saveCliConfig(currentCliConfig);
}

async function getInstancesConfig() {
  try {
    const stat = await fs.stat(INSTANCES_CONFIG_PATH).catch(() => null);
    if (stat && _instancesConfigCache && stat.mtimeMs === _instancesConfigMtime) {
      return _instancesConfigCache;
    }

    if (!(await fs.pathExists(INSTANCES_CONFIG_PATH))) {
      const defaultConfig = { instances: {} };
      await fs.writeJson(INSTANCES_CONFIG_PATH, defaultConfig, { mode: 0o600 });
      _instancesConfigCache = defaultConfig;
      _instancesConfigMtime = Date.now();
      return _instancesConfigCache;
    }

    _instancesConfigCache = await fs.readJson(INSTANCES_CONFIG_PATH);
    _instancesConfigMtime = stat?.mtimeMs || Date.now();
    return _instancesConfigCache;
  } catch {
    const defaultConfig = { instances: {} };
    _instancesConfigCache = defaultConfig;
    return defaultConfig;
  }
}

async function saveInstancesConfig(config) {
  _instancesConfigCache = config;
  await fs.writeJson(INSTANCES_CONFIG_PATH, config, { spaces: 2, mode: 0o600 });
  const stat = await fs.stat(INSTANCES_CONFIG_PATH).catch(() => null);
  _instancesConfigMtime = stat?.mtimeMs || Date.now();
}

async function downloadPocketBaseIfNotExists(versionOverride = null, interactive = true) {
  const versionToDownload = versionOverride || (await getLatestPocketBaseVersion());
  const execExists = await fs.pathExists(POCKETBASE_EXEC_PATH);

  if (!versionOverride && execExists) {
    if (completeLogging && interactive) {
      console.log(chalk.green(`PocketBase executable already exists at ${POCKETBASE_EXEC_PATH}. Skipping download.`));
    }
    return { success: true, message: "PocketBase executable already exists." };
  }

  if (execExists) {
    if (interactive) {
      const { confirmOverwrite } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmOverwrite",
          message: `PocketBase executable already exists at ${POCKETBASE_EXEC_PATH}. Do you want to remove it and download version ${versionToDownload}?`,
          default: false,
        },
      ]);
      if (!confirmOverwrite) {
        console.log(chalk.yellow("Download cancelled by user."));
        return { success: false, message: "Download cancelled by user." };
      }
    }
    if (completeLogging) {
      console.log(chalk.yellow(`Removing existing PocketBase executable at ${POCKETBASE_EXEC_PATH} to download version ${versionToDownload}...`));
    }
    await fs.remove(POCKETBASE_EXEC_PATH);
  }

  try {
    await fs.ensureDir(POCKETBASE_BIN_DIR);
    await fs.writeFile(POCKETBASE_DOWNLOAD_LOCK_PATH, String(process.pid), { flag: "wx" });
  } catch (e) {
    if (e.code === "EEXIST") {
      if (interactive) {
        console.log(chalk.yellow(`Another PocketBase download process may be active. Please wait or clear the lock file if stuck: ${POCKETBASE_DOWNLOAD_LOCK_PATH}`));
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (await fs.pathExists(POCKETBASE_EXEC_PATH)) {
        return { success: true, message: "PocketBase executable now exists (likely downloaded by another process)." };
      }
      return { success: false, message: "Download lock held by another process." };
    }
    throw e;
  }

  const downloadUrl = `https://github.com/pocketbase/pocketbase/releases/download/v${versionToDownload}/pocketbase_${versionToDownload}_linux_amd64.zip`;
  if (completeLogging) {
    console.log(chalk.blue(`Downloading PocketBase v${versionToDownload} from ${downloadUrl}...`));
  }

  try {
    const response = await nlcurlGet(downloadUrl, { stream: true });
    const zipPath = path.join(POCKETBASE_BIN_DIR, "pocketbase.zip");
    const writer = fs.createWriteStream(zipPath);

    await new Promise((resolve, reject) => {
      response.body.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    if (completeLogging) {
      console.log(chalk.blue("Unzipping PocketBase..."));
    }

    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: POCKETBASE_BIN_DIR }))
      .promise();

    await Promise.all([fs.remove(zipPath), fs.chmod(POCKETBASE_EXEC_PATH, "755")]);

    if (completeLogging && interactive) {
      console.log(chalk.green(`PocketBase v${versionToDownload} downloaded and extracted successfully to ${POCKETBASE_EXEC_PATH}.`));
    }
    return { success: true, message: `PocketBase v${versionToDownload} downloaded.` };
  } catch (error) {
    if (interactive) {
      console.error(chalk.red(`Error downloading or extracting PocketBase v${versionToDownload}:`), error.message);
      if (error.statusCode === 404) {
        console.error(chalk.red(`Version ${versionToDownload} not found. Please check the version number.`));
      }
    }
    if (!interactive) {
      return { success: false, message: `Error downloading or extracting PocketBase v${versionToDownload}: ${error.message}`, error };
    }
    throw error;
  } finally {
    await fs.remove(POCKETBASE_DOWNLOAD_LOCK_PATH).catch(() => {});
  }
}

async function updatePm2EcosystemFile() {
  const config = await getInstancesConfig();
  const instanceNames = Object.keys(config.instances);

  const apps = new Array(instanceNames.length);

  for (let i = 0; i < instanceNames.length; i++) {
    const inst = config.instances[instanceNames[i]];
    const migrationsDir = path.join(inst.dataDir, "pb_migrations");
    const hooksDir = path.join(inst.dataDir, "pb_hooks");
    apps[i] = {
      name: `${PM2_INSTANCE_PREFIX}${inst.name}`,
      script: POCKETBASE_EXEC_PATH,
      args: `serve --http "127.0.0.1:${inst.port}" --dir "${inst.dataDir}" --migrationsDir "${migrationsDir}" --hooksDir "${hooksDir}"`,
      cwd: inst.dataDir,
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      env: { NODE_ENV: "production" },
    };
  }

  const ecosystemContent = `module.exports = { apps: ${JSON.stringify(apps, null, 2)} };`;
  const tempEcosystemFile = `${PM2_ECOSYSTEM_FILE}.${Date.now()}.tmp`;
  await fs.writeFile(tempEcosystemFile, ecosystemContent);
  await fs.rename(tempEcosystemFile, PM2_ECOSYSTEM_FILE);

  if (completeLogging) {
    console.log(chalk.green("PM2 ecosystem file updated."));
  }
  return { success: true, message: "PM2 ecosystem file updated." };
}

async function reloadPm2(specificInstanceName = null) {
  try {
    if (specificInstanceName) {
      await safeRunCommand("pm2", ["restart", `${PM2_INSTANCE_PREFIX}${specificInstanceName}`], `Failed to restart PM2 process ${PM2_INSTANCE_PREFIX}${specificInstanceName}`);
    } else {
      await safeRunCommand("pm2", ["reload", PM2_ECOSYSTEM_FILE], "Failed to reload PM2 ecosystem");
    }
    await safeRunCommand("pm2", ["save"], "Failed to save PM2 state", true);
    const message = specificInstanceName ? `PM2 process ${PM2_INSTANCE_PREFIX}${specificInstanceName} restarted and PM2 state saved.` : "PM2 ecosystem reloaded and PM2 state saved.";
    if (completeLogging) {
      console.log(chalk.green(message));
    }
    return { success: true, message };
  } catch (error) {
    const message = `Failed to reload PM2: ${error.message}`;
    console.error(chalk.red(message));
    return { success: false, message, error };
  }
}

async function addClientMaxBodyToHttpBlockIfMissing(sizeValue) {
  const clientMaxBodySetting = `client_max_body_size ${sizeValue};`;

  try {
    if (!(await fs.pathExists(NGINX_GLOBAL_CONF_PATH))) {
      console.log(chalk.yellow(`${NGINX_GLOBAL_CONF_PATH} not found. Skipping modification.`));
      return { success: false, message: `${NGINX_GLOBAL_CONF_PATH} not found.` };
    }

    const backupPath = `${NGINX_GLOBAL_CONF_PATH}.pbmanager_bak_${Date.now()}`;
    await safeRunCommand("sudo", ["cp", NGINX_GLOBAL_CONF_PATH, backupPath], `Failed to backup ${NGINX_GLOBAL_CONF_PATH}`);
    if (completeLogging) {
      console.log(chalk.blue(`Backed up ${NGINX_GLOBAL_CONF_PATH} to ${backupPath}`));
    }

    const { stdout: originalContent } = await safeRunCommand("sudo", ["cat", NGINX_GLOBAL_CONF_PATH]);
    const lines = originalContent.split("\n");
    const lineCount = lines.length;

    let httpBlockStartIndex = -1;
    let inHttpBlock = false;
    let braceCount = 0;
    let alreadySetCorrectly = false;
    let foundWithDifferentValue = false;
    let modified = false;

    for (let i = 0; i < lineCount; i++) {
      const trimmedLine = lines[i].trim();

      if (!inHttpBlock) {
        if (trimmedLine.startsWith("http") && trimmedLine.endsWith("{")) {
          inHttpBlock = true;
          httpBlockStartIndex = i;
          braceCount = 1;
        }
        continue;
      }

      const openBraces = (trimmedLine.match(/{/g) || []).length;
      const closeBraces = (trimmedLine.match(/}/g) || []).length;
      braceCount += openBraces - closeBraces;

      if (trimmedLine.startsWith("client_max_body_size")) {
        if (trimmedLine === clientMaxBodySetting) {
          if (completeLogging) {
            console.log(chalk.green(`'${clientMaxBodySetting}' is already correctly set in the http block of ${NGINX_GLOBAL_CONF_PATH}.`));
          }
          alreadySetCorrectly = true;
          break;
        }
        console.log(chalk.yellow(`Found 'client_max_body_size' in the http block of ${NGINX_GLOBAL_CONF_PATH} with a different value: "${trimmedLine}".`));
        console.log(chalk.yellow("To avoid conflicts, this script will not modify it. Please check your Nginx configuration manually if needed."));
        foundWithDifferentValue = true;
        break;
      }

      if (braceCount === 0) {
        inHttpBlock = false;
        if (httpBlockStartIndex !== -1 && !alreadySetCorrectly && !foundWithDifferentValue) {
          const indentation = `${lines[httpBlockStartIndex].match(WHITESPACE_REGEX)[0]}  `;
          lines.splice(httpBlockStartIndex + 1, 0, `${indentation}${clientMaxBodySetting}`);
          modified = true;
          if (completeLogging) {
            console.log(chalk.yellow(`'${clientMaxBodySetting}' was not found in the http block. Adding it.`));
          }
        }
        httpBlockStartIndex = -1;
      }
    }

    if (alreadySetCorrectly || foundWithDifferentValue) {
      return { success: true, message: "Global Nginx config checked. No automatic changes made due to existing settings." };
    }

    if (!modified && inHttpBlock && httpBlockStartIndex !== -1) {
      const indentation = `${lines[httpBlockStartIndex].match(WHITESPACE_REGEX)[0]}  `;
      lines.splice(httpBlockStartIndex + 1, 0, `${indentation}${clientMaxBodySetting}`);
      modified = true;
      if (completeLogging) {
        console.log(chalk.yellow(`'${clientMaxBodySetting}' was not found in the http block (reached end of file). Adding it.`));
      }
    }

    if (!modified && httpBlockStartIndex === -1 && !inHttpBlock) {
      console.log(chalk.red(`Could not find the 'http {' block in ${NGINX_GLOBAL_CONF_PATH}. Cannot add '${clientMaxBodySetting}'.`));
      return { success: false, message: "Http block not found in global Nginx config." };
    }

    if (modified) {
      const tempNginxGlobalConfPath = `/tmp/nginx.conf.pbmanager.${Date.now()}`;
      await fs.writeFile(tempNginxGlobalConfPath, lines.join("\n"));
      await safeRunCommand("sudo", ["mv", tempNginxGlobalConfPath, NGINX_GLOBAL_CONF_PATH], `Failed to update ${NGINX_GLOBAL_CONF_PATH}`);
      if (completeLogging) {
        console.log(chalk.green(`${NGINX_GLOBAL_CONF_PATH} updated to include '${clientMaxBodySetting}' in the http block.`));
      }
      return { success: true, message: `${NGINX_GLOBAL_CONF_PATH} updated to include '${clientMaxBodySetting}'.` };
    }

    if (completeLogging) {
      console.log(chalk.blue(`No changes made to ${NGINX_GLOBAL_CONF_PATH} regarding '${clientMaxBodySetting}' in the http block.`));
    }
    return { success: true, message: "No changes needed or made to global Nginx config http block." };
  } catch (error) {
    console.error(chalk.red(`Error modifying ${NGINX_GLOBAL_CONF_PATH}: ${error.message}`));
    return { success: false, message: `Error modifying ${NGINX_GLOBAL_CONF_PATH}: ${error.message}`, error };
  }
}

const NGINX_SECURITY_HEADERS = `
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-XSS-Protection "1; mode=block" always;
  `;

const NGINX_PROXY_HEADERS = `
          proxy_http_version 1.1;

          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection 'upgrade';
          proxy_set_header Host $host;
          proxy_set_header X-Forwarded-Proto $scheme;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Real-IP $remote_addr;

          proxy_cache_bypass $http_upgrade;`;

async function generateNginxConfig(instanceName, domain, port, useHttps, useHttp2, clientMaxBodySize, attemptGlobalClientMaxBodySize = false, allowedIps = [], adminOnlyRestriction = false, optimizeRealtime = false) {
  const clientMaxBody = clientMaxBodySize ? `client_max_body_size ${clientMaxBodySize};` : "";
  const hasIpRestrictions = allowedIps && allowedIps.length > 0;

  let ipRestrictionDirectives = "";
  let adminLocationBlock = "";

  if (hasIpRestrictions) {
    const allowDirectives = allowedIps.map((ip) => `allow ${ip};`).join("\n          ");

    if (adminOnlyRestriction) {
      adminLocationBlock = `
        location /_/ {
          ${clientMaxBody}
          ${allowDirectives}
          deny all;

          proxy_pass http://127.0.0.1:${port};
${NGINX_PROXY_HEADERS}
        }
`;
    } else {
      ipRestrictionDirectives = `
          ${allowDirectives}
          deny all;`;
    }
  }

  let realtimeLocationBlock = "";
  if (optimizeRealtime) {
    realtimeLocationBlock = `
        location /api/realtime {
          proxy_pass http://127.0.0.1:${port};

          proxy_http_version 1.1;
          proxy_set_header Connection '';
          proxy_set_header Host $host;
          proxy_set_header X-Forwarded-Proto $scheme;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Real-IP $remote_addr;

          # SSE streams are long-lived — prevent nginx from killing idle connections
          proxy_read_timeout 86400s;
          proxy_send_timeout 86400s;
          send_timeout 86400s;

          # Flush SSE events immediately to clients
          proxy_buffering off;
          proxy_cache off;
        }
`;
  }

  const http2Suffix = useHttp2 ? " http2" : "";
  let configContent;

  if (useHttps) {
    configContent = `
      server {
        listen 80;
        listen [::]:80;
        server_name ${domain};
        location / {
          return 301 https://$host$request_uri;
        }
      }

      server {
        server_name ${domain};
        ${clientMaxBody}
        
        ${NGINX_SECURITY_HEADERS}
${adminLocationBlock}
${realtimeLocationBlock}
        location / {
          ${clientMaxBody}
          ${ipRestrictionDirectives}

          proxy_pass http://127.0.0.1:${port};
${NGINX_PROXY_HEADERS}
        }

        listen 443 ssl${http2Suffix};
        listen [::]:443 ssl${http2Suffix};

        ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;

        include /etc/letsencrypt/options-ssl-nginx.conf;
        
        ssl_dhparam /etc/letsencrypt/ssl-dhparam.pem;
      }
    `;
  } else {
    configContent = `
      server {
        server_name ${domain};
        ${clientMaxBody}

        ${NGINX_SECURITY_HEADERS}
${adminLocationBlock}
${realtimeLocationBlock}
        location / {
          ${clientMaxBody}
          ${ipRestrictionDirectives}

          proxy_pass http://127.0.0.1:${port};
${NGINX_PROXY_HEADERS}
        }

        listen 80${http2Suffix};
        listen [::]:80${http2Suffix};
      }
    `;
  }

  const isRhel = NGINX_DISTRO_MODE === "rhel";
  const nginxConfPath = isRhel ? path.join(NGINX_SITES_AVAILABLE, `${instanceName}.conf`) : path.join(NGINX_SITES_AVAILABLE, instanceName);
  const nginxEnabledPath = isRhel ? nginxConfPath : path.join(NGINX_SITES_ENABLED, instanceName);

  if (completeLogging) {
    console.log(chalk.blue(`Generating Nginx config for ${instanceName} at ${nginxConfPath}`));
  }

  const tempNginxConfPath = `${nginxConfPath}.${Date.now()}.tmp`;
  await fs.writeFile(tempNginxConfPath, configContent.trim());

  try {
    await safeRunCommand("sudo", ["mv", tempNginxConfPath, nginxConfPath], `Failed to move Nginx config to ${nginxConfPath}`);
  } catch (error) {
    await fs.remove(tempNginxConfPath).catch(() => {});
    throw error;
  }

  if (!isRhel) {
    if (completeLogging) {
      console.log(chalk.blue(`Creating Nginx symlink: ${nginxEnabledPath}`));
    }
    try {
      await safeRunCommand("sudo", ["ln", "-sfn", nginxConfPath, nginxEnabledPath], `Failed to create Nginx symlink for ${nginxConfPath} to ${nginxEnabledPath}`);
    } catch (error) {
      const errorMsg = `Failed to create Nginx symlink for ${nginxConfPath} to ${nginxEnabledPath}: ${error.message}. Please try running this command with sudo, or create the symlink manually.`;
      console.error(chalk.red(errorMsg));
      console.log(chalk.yellow(`Manually run: sudo ln -sfn ${nginxConfPath} ${nginxEnabledPath}`));
      throw new Error(errorMsg);
    }
  }

  if (clientMaxBodySize && attemptGlobalClientMaxBodySize) {
    const httpBlockUpdateResult = await addClientMaxBodyToHttpBlockIfMissing(clientMaxBodySize);
    if (httpBlockUpdateResult.success) {
      if (completeLogging) {
        console.log(chalk.green("Global Nginx config check/update process for http block completed."));
      }
    } else {
      console.log(chalk.red("Global Nginx config check/update process for http block encountered an issue. Please check manually."));
      if (httpBlockUpdateResult.message) {
        console.log(chalk.red(`Details: ${httpBlockUpdateResult.message}`));
      }
    }
  }

  return { success: true, message: `Nginx config generated for ${instanceName} at ${nginxConfPath}`, path: nginxConfPath };
}

async function reloadNginx() {
  if (completeLogging) {
    console.log(chalk.blue("Testing Nginx configuration..."));
  }
  try {
    await safeRunCommand("sudo", ["nginx", "-t"], "Nginx configuration test failed");
    if (completeLogging) {
      console.log(chalk.blue("Reloading Nginx..."));
    }

    const reloadMethods = [
      { check: () => shell.which("systemctl"), cmd: ["systemctl", "reload", "nginx"] },
      { check: () => shell.which("service"), cmd: ["service", "nginx", "reload"] },
      { check: () => true, cmd: ["nginx", "-s", "reload"] },
    ];

    for (const method of reloadMethods) {
      if (method.check()) {
        try {
          await safeRunCommand("sudo", method.cmd, "Failed to reload Nginx");
          if (completeLogging) {
            console.log(chalk.green("Nginx reloaded successfully."));
          }
          return { success: true, message: "Nginx reloaded." };
        } catch {}
      }
    }

    throw new Error("Could not reload Nginx with systemctl, service, or nginx -s reload.");
  } catch (error) {
    const errorMsg = `Nginx test failed or reload failed: ${error.message}. Please check Nginx configuration.`;
    console.error(chalk.red(errorMsg));
    console.log(chalk.yellow("You can try to diagnose Nginx issues by running: sudo nginx -t"));
    console.log(chalk.yellow("Check Nginx error logs, typically found in /var/log/nginx/error.log"));
    return { success: false, message: errorMsg, error };
  }
}

async function ensureDhParamExists() {
  const dhParamPath = "/etc/letsencrypt/ssl-dhparam.pem";
  if (await fs.pathExists(dhParamPath)) {
    if (completeLogging) {
      console.log(chalk.green(`${dhParamPath} already exists.`));
    }
    return { success: true, message: `${dhParamPath} already exists.` };
  }

  if (completeLogging) {
    console.log(chalk.yellow(`${dhParamPath} not found. Generating... This may take a few minutes.`));
  }
  try {
    await fs.ensureDir("/etc/letsencrypt");
    await safeRunCommand("sudo", ["openssl", "dhparam", "-out", dhParamPath, "2048"], `Failed to generate ${dhParamPath}. Nginx might fail to reload.`);
    if (completeLogging) {
      console.log(chalk.green(`${dhParamPath} generated successfully.`));
    }
    return { success: true, message: `${dhParamPath} generated successfully.` };
  } catch (error) {
    const errorMsg = `Error generating ${dhParamPath}: ${error.message}`;
    console.error(chalk.red(errorMsg));
    return { success: false, message: errorMsg };
  }
}

async function runCertbot(domain, email, isCliCall = true) {
  if (!shell.which("certbot")) {
    const msg = "Certbot command not found. Please install Certbot first.";
    if (isCliCall) console.error(chalk.red(msg));
    return { success: false, message: msg };
  }
  if (completeLogging && isCliCall) {
    console.log(chalk.blue(`Attempting to obtain SSL certificate for ${domain} using Certbot...`));
  }
  try {
    await safeRunCommand("sudo", ["mkdir", "-p", "/var/www/html"], "Creating /var/www/html for Certbot", true);
  } catch (e) {}

  const certbotArgs = ["--nginx", "-d", domain, "--non-interactive", "--agree-tos", "-m", email, "--redirect"];
  if (NGINX_DISTRO_MODE === "rhel") {
    certbotArgs.push("--nginx-server-root", "/etc/nginx/");
  }

  if (isCliCall) {
    const { confirmCertbotRun } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmCertbotRun",
        message: `Ready to run Certbot for domain ${domain} with email ${email}. Command: sudo certbot ${certbotArgs.join(" ")}. Proceed?`,
        default: true,
      },
    ]);
    if (!confirmCertbotRun) {
      console.log(chalk.yellow("Certbot execution cancelled by user."));
      return { success: false, message: "Certbot execution cancelled by user." };
    }
  }

  try {
    await safeRunCommand("sudo", ["certbot", ...certbotArgs], "Certbot command failed.");
    const successMsg = `Certbot successfully obtained and installed certificate for ${domain}.`;
    if (completeLogging && isCliCall) console.log(chalk.green(successMsg));
    return { success: true, message: successMsg };
  } catch (error) {
    const errorMsg = `Certbot failed for ${domain}: ${error.message}. Check Certbot logs.`;
    if (isCliCall) {
      console.error(chalk.red(errorMsg));
      console.log(chalk.yellow("You can try running Certbot manually or check logs in /var/log/letsencrypt/"));
    }
    return { success: false, message: errorMsg, error };
  }
}

function getCertExpiryDays(domain) {
  return new Promise((resolve) => {
    let socket;
    let resolved = false;

    const cleanup = (value) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }
      resolve(value);
    };

    const timeoutId = setTimeout(() => cleanup("-"), HTTP_TIMEOUT);

    try {
      socket = tls.connect(
        {
          host: domain,
          port: 443,
          servername: domain,
          rejectUnauthorized: false,
          timeout: TLS_TIMEOUT,
        },
        () => {
          const cert = socket.getPeerCertificate();
          if (!cert?.valid_to) {
            cleanup("-");
            return;
          }
          const expiryDate = new Date(cert.valid_to);
          const daysLeft = Math.ceil((expiryDate.getTime() - Date.now()) / 86400000);
          cleanup(daysLeft);
          socket.end();
        },
      );

      socket.on("error", () => cleanup("-"));
      socket.on("timeout", () => cleanup("-"));
    } catch {
      cleanup("-");
    }
  });
}

async function _internalListInstances() {
  const config = await getInstancesConfig();
  const instanceNames = Object.keys(config.instances);

  if (instanceNames.length === 0) {
    return [];
  }

  const { stdout } = await safeRunCommand("pm2", ["jlist", "--silent"], "Failed to query PM2 process list", false, { cwd: CONFIG_DIR, silent: true });
  let pm2List;
  try {
    pm2List = JSON.parse(stdout);
  } catch {
    throw new Error("Failed to read PM2 process list: PM2 returned invalid JSON.");
  }
  if (!Array.isArray(pm2List)) {
    throw new Error("Failed to read PM2 process list: expected an array.");
  }

  const pm2Statuses = {};
  const prefixLen = PM2_INSTANCE_PREFIX.length;
  for (const proc of pm2List) {
    if (typeof proc?.name !== "string" || typeof proc.pm2_env?.status !== "string" || !proc.pm2_env.status) {
      throw new Error("Failed to read PM2 process list: invalid process name or status.");
    }
    if (proc.name.startsWith(PM2_INSTANCE_PREFIX)) {
      pm2Statuses[proc.name.substring(prefixLen)] = proc.pm2_env.status;
    }
  }

  const httpsInstances = [];
  for (const name of instanceNames) {
    const inst = config.instances[name];
    if (inst.useHttps) {
      httpsInstances.push({ name, domain: inst.domain });
    }
  }

  const certExpiryMap = {};
  if (httpsInstances.length > 0) {
    const expiryPromises = httpsInstances.map(({ name, domain }) => getCertExpiryDays(domain).then((days) => ({ name, days })));
    const results = await Promise.all(expiryPromises);
    for (const { name, days } of results) {
      certExpiryMap[name] = days;
    }
  }

  const output = new Array(instanceNames.length);
  for (let i = 0; i < instanceNames.length; i++) {
    const name = instanceNames[i];
    const inst = config.instances[name];
    const protocol = inst.useHttps ? "https" : "http";
    const publicUrl = `${protocol}://${inst.domain}`;

    output[i] = {
      name,
      domain: inst.domain,
      protocol,
      publicUrl: `${publicUrl}/_/`,
      internalPort: inst.port,
      dataDirectory: inst.dataDir,
      pm2Status: pm2Statuses[name] ?? "NOT FOUND",
      adminURL: `http://127.0.0.1:${inst.port}/_/`,
      certExpiryDays: inst.useHttps ? (certExpiryMap[name] ?? "-") : "-",
    };
  }

  return output;
}

async function _internalAddInstance(payload) {
  const { name, domain, port, useHttps = true, emailForCertbot, useHttp2 = true, clientMaxBodySize, autoRunCertbot = true, attemptGlobalClientMaxBodySize, allowedIps = [], adminOnlyRestriction = false, optimizeRealtime = false } = payload;
  const results = { success: false, messages: [], instance: null, nginxConfigPath: null, certbotSuccess: null, error: null };

  try {
    await ensureBaseSetup();
    const [pbDownloadResult, config] = await Promise.all([downloadPocketBaseIfNotExists(null, false), getInstancesConfig()]);

    if (pbDownloadResult?.success === false && !(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      results.messages.push(`PocketBase executable not found and download failed: ${pbDownloadResult.message}`);
      results.error = "PocketBase download failed";
      return results;
    }

    if (config.instances[name]) {
      results.messages.push(`Instance "${name}" already exists.`);
      results.error = "Instance already exists";
      return results;
    }

    for (const inst of Object.values(config.instances)) {
      if (inst.port === port) {
        results.messages.push(`Port ${port} is already in use by instance "${inst.name}".`);
        results.error = "Port in use";
        return results;
      }
      if (inst.domain === domain) {
        results.messages.push(`Domain ${domain} is already in use by instance "${inst.name}".`);
        results.error = "Domain in use";
        return results;
      }
    }

    if (useHttps && !emailForCertbot) {
      results.messages.push("Email for Certbot is required when HTTPS is enabled.");
      results.error = "Missing Certbot email";
      return results;
    }

    const instanceDataDir = path.join(INSTANCES_DATA_BASE_DIR, name);
    const instanceHooksDir = path.join(instanceDataDir, "pb_hooks");
    const instanceMigrationsDir = path.join(instanceDataDir, "pb_migrations");
    await Promise.all([fs.ensureDir(instanceDataDir), fs.ensureDir(instanceHooksDir), fs.ensureDir(instanceMigrationsDir)]);

    const newInstanceConfig = { name, domain, port, dataDir: instanceDataDir, useHttps, emailForCertbot: useHttps ? emailForCertbot : null, useHttp2, clientMaxBodySize, allowedIps, adminOnlyRestriction, optimizeRealtime };
    config.instances[name] = newInstanceConfig;
    await saveInstancesConfig(config);

    if (completeLogging) results.messages.push(`Instance "${name}" configuration saved.`);
    results.instance = newInstanceConfig;
    let certbotRanSuccessfully = false;

    const nginxResult = await generateNginxConfig(name, domain, port, false, false, clientMaxBodySize, attemptGlobalClientMaxBodySize, allowedIps, adminOnlyRestriction, optimizeRealtime);
    results.nginxConfigPath = nginxResult.path;
    if (completeLogging) results.messages.push(nginxResult.message);
    else if (!nginxResult.success) results.messages.push(nginxResult.message);

    const nginxReload1 = await reloadNginx();
    if (!nginxReload1.success) {
      results.messages.push(`Nginx reload failed: ${nginxReload1.message}`);
      throw nginxReload1.error || new Error(nginxReload1.message);
    }
    if (completeLogging) {
      results.messages.push(nginxReload1.message);
    }

    if (useHttps) {
      await ensureDhParamExists();
      if (autoRunCertbot) {
        const certbotResult = await runCertbot(domain, emailForCertbot, false);
        results.certbotSuccess = certbotResult.success;
        results.messages.push(`Certbot for ${domain}: ${certbotResult.message}`);
        certbotRanSuccessfully = certbotResult.success;
        if (certbotResult.success) {
          const httpsNginxResult = await generateNginxConfig(name, domain, port, true, useHttp2, clientMaxBodySize, attemptGlobalClientMaxBodySize, allowedIps, adminOnlyRestriction, optimizeRealtime);
          if (completeLogging) results.messages.push(httpsNginxResult.message);
          else if (!httpsNginxResult.success) results.messages.push(httpsNginxResult.message);
        } else {
          results.messages.push("Certbot failed. Nginx remains HTTP-only. You may need to run Certbot manually.");
        }
      } else {
        const httpsNginxResult = await generateNginxConfig(name, domain, port, true, useHttp2, clientMaxBodySize, attemptGlobalClientMaxBodySize, allowedIps, adminOnlyRestriction, optimizeRealtime);
        if (completeLogging) results.messages.push(httpsNginxResult.message);
        else if (!httpsNginxResult.success) results.messages.push(httpsNginxResult.message);
        results.messages.push("HTTPS Nginx config generated, Certbot not run automatically. Manual run needed for SSL.");
      }
    } else if (completeLogging) {
      results.messages.push("HTTP-only Nginx config generated (or updated).");
    }

    const nginxReload2 = await reloadNginx();
    if (!nginxReload2.success) {
      results.messages.push(`Nginx final reload failed: ${nginxReload2.message}`);
      throw nginxReload2.error || new Error(nginxReload2.message);
    }
    if (completeLogging) {
      results.messages.push(nginxReload2.message);
    }

    const pm2UpdateResult = await updatePm2EcosystemFile();
    if (!pm2UpdateResult.success) throw new Error(pm2UpdateResult.message);
    if (completeLogging) results.messages.push(pm2UpdateResult.message);

    const pm2ReloadResult = await reloadPm2();
    if (!pm2ReloadResult.success) throw new Error(pm2ReloadResult.message);
    if (completeLogging) results.messages.push(pm2ReloadResult.message);

    results.success = true;
    const finalProtocol = useHttps && certbotRanSuccessfully ? "https" : "http";
    results.instance.url = `${finalProtocol}://${domain}/_/`;
    results.messages.push(`Instance "${name}" added and started. Access at ${results.instance.url}`);
  } catch (error) {
    results.messages.push(`Error during internal add instance: ${error.message}`);
    results.error = error.message;
    if (completeLogging) console.error(error.stack);
  }
  return results;
}

async function _internalRemoveInstance(payload) {
  const { name } = payload;
  const results = { success: false, messages: [], error: null };
  try {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      results.error = `Instance "${name}" not found.`;
      results.messages.push(results.error);
      return results;
    }
    const instanceDataDir = config.instances[name].dataDir;
    try {
      await safeRunCommand("pm2", ["stop", `${PM2_INSTANCE_PREFIX}${name}`], `Stopping ${PM2_INSTANCE_PREFIX}${name}`, true);
      if (completeLogging) results.messages.push(`Attempted to stop PM2 process ${PM2_INSTANCE_PREFIX}${name}.`);
      await safeRunCommand("pm2", ["delete", `${PM2_INSTANCE_PREFIX}${name}`], `Deleting ${PM2_INSTANCE_PREFIX}${name}`, true);
      if (completeLogging) results.messages.push(`Attempted to delete PM2 process ${PM2_INSTANCE_PREFIX}${name}.`);
    } catch (e) {
      results.messages.push(`Warning: Could not stop/delete PM2 process ${PM2_INSTANCE_PREFIX}${name} (maybe not running/exists): ${e.message}`);
    }

    const nginxConfPathBase = NGINX_DISTRO_MODE === "rhel" ? `${name}.conf` : name;
    const nginxConfPath = path.join(NGINX_SITES_AVAILABLE, nginxConfPathBase);
    const nginxEnabledPath = NGINX_DISTRO_MODE === "rhel" ? nginxConfPath : path.join(NGINX_SITES_ENABLED, name);

    if (NGINX_DISTRO_MODE !== "rhel" && (await fs.pathExists(nginxEnabledPath))) {
      try {
        await safeRunCommand("sudo", ["rm", nginxEnabledPath], `Failed to remove Nginx symlink ${nginxEnabledPath}`);
        if (completeLogging) results.messages.push(`Removed Nginx symlink ${nginxEnabledPath}.`);
      } catch (e) {
        results.messages.push(`Warning: Failed to remove Nginx symlink ${nginxEnabledPath}: ${e.message}`);
      }
    }
    if (await fs.pathExists(nginxConfPath)) {
      try {
        await safeRunCommand("sudo", ["rm", nginxConfPath], `Failed to remove Nginx config ${nginxConfPath}`);
        if (completeLogging) results.messages.push(`Removed Nginx config ${nginxConfPath}.`);
      } catch (e) {
        results.messages.push(`Warning: Failed to remove Nginx config ${nginxConfPath}: ${e.message}`);
      }
    }

    delete config.instances[name];
    await saveInstancesConfig(config);
    if (completeLogging) results.messages.push(`Instance "${name}" removed from configuration.`);

    const pm2UpdateRes = await updatePm2EcosystemFile();
    if (completeLogging && pm2UpdateRes.success) results.messages.push(pm2UpdateRes.message);

    const nginxReloadRes = await reloadNginx();
    if (completeLogging && nginxReloadRes.success) results.messages.push(nginxReloadRes.message);
    else if (!nginxReloadRes.success) results.messages.push(`Nginx reload after removal failed: ${nginxReloadRes.message}`);

    try {
      await safeRunCommand("pm2", ["save"], "PM2 save failed", true);
      if (completeLogging) results.messages.push("PM2 state saved.");
    } catch (e) {
      if (completeLogging) results.messages.push(`PM2 save failed: ${e.message}`);
    }

    if (payload.deleteData) {
      try {
        await fs.remove(instanceDataDir);
        results.messages.push(`Data directory ${instanceDataDir} deleted successfully.`);
      } catch (err) {
        results.messages.push(`Failed to delete data directory ${instanceDataDir}: ${err.message}. Manual deletion may be required.`);
        results.error = results.error ? `${results.error}; Data deletion failed` : "Data deletion failed";
      }
    } else {
      results.messages.push(`Data directory at ${instanceDataDir} was NOT deleted. Manual deletion required if desired.`);
    }
    results.success = true;
  } catch (error) {
    results.messages.push(`Error during internal remove instance: ${error.message}`);
    results.error = error.message;
  }
  return results;
}

async function _internalResetInstance(payload) {
  const { name, createAdmin = false, adminEmail, adminPassword } = payload;
  const results = { success: false, messages: [], error: null };
  try {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      results.error = `Instance "${name}" not found.`;
      results.messages.push(results.error);
      return results;
    }
    const instance = config.instances[name];
    const dataDir = instance.dataDir;

    // Keep this process and its children outside the directory being deleted.
    process.chdir(CONFIG_DIR);

    if (completeLogging) results.messages.push(`Stopping and deleting PM2 process for ${PM2_INSTANCE_PREFIX}${name}...`);
    try {
      await safeRunCommand("pm2", ["stop", `${PM2_INSTANCE_PREFIX}${name}`], `Stopping ${PM2_INSTANCE_PREFIX}${name}`, true);
      await safeRunCommand("pm2", ["delete", `${PM2_INSTANCE_PREFIX}${name}`], `Deleting ${PM2_INSTANCE_PREFIX}${name}`, true);
    } catch (e) {
      results.messages.push(`Warning: Could not stop/delete PM2 process ${PM2_INSTANCE_PREFIX}${name} (maybe not running/exists): ${e.message}`);
    }

    if (completeLogging) results.messages.push(`Deleting data directory ${dataDir}...`);
    if (await fs.pathExists(dataDir)) {
      try {
        await fs.remove(dataDir);
        results.messages.push(`Data directory ${dataDir} deleted.`);
      } catch (e) {
        results.error = `Failed to delete data directory: ${e.message}`;
        results.messages.push(results.error);
        return results;
      }
    }
    const hooksDir = path.join(dataDir, "pb_hooks");
    const migrationsDir = path.join(dataDir, "pb_migrations");
    await Promise.all([fs.ensureDir(dataDir), fs.ensureDir(hooksDir), fs.ensureDir(migrationsDir)]);
    if (completeLogging) results.messages.push(`Data directory ${dataDir} recreated.`);

    const pm2UpdateRes = await updatePm2EcosystemFile();
    if (completeLogging && pm2UpdateRes.success) results.messages.push(pm2UpdateRes.message);

    const pm2ReloadRes = await reloadPm2();
    if (!pm2ReloadRes.success) throw new Error(`PM2 reload after reset failed: ${pm2ReloadRes.message}`);
    if (completeLogging) results.messages.push(pm2ReloadRes.message);

    if (completeLogging) results.messages.push(`Instance "${name}" services reloaded after reset.`);

    if (createAdmin) {
      if (!adminEmail || !adminPassword) {
        results.messages.push("Admin email and password required for admin creation during reset, but not provided. Skipping admin creation.");
      } else {
        const migrationsDir = path.join(dataDir, "pb_migrations");
        const adminCreateArgs = ["superuser", "create", adminEmail, adminPassword, "--dir", dataDir, "--migrationsDir", migrationsDir];
        if (completeLogging) results.messages.push(`Attempting to create superuser (admin) account: ${adminEmail}`);
        try {
          const adminResult = await safeRunCommand(POCKETBASE_EXEC_PATH, adminCreateArgs, "Failed to create superuser (admin) account via CLI.");
          if (adminResult?.stdout?.includes("Successfully created new superuser")) {
            if (completeLogging) results.messages.push(adminResult.stdout.trim());
            results.messages.push(`Superuser (admin) account for ${adminEmail} created successfully!`);
          } else {
            if (completeLogging) results.messages.push(`Admin creation output: ${adminResult.stdout} ${adminResult.stderr}`);
            else results.messages.push(`Admin creation for ${adminEmail} may have failed. Check logs if needed.`);
          }
        } catch (e) {
          results.messages.push(`Superuser (admin) account creation via CLI failed: ${e.message}`);
        }
      }
    }
    if (completeLogging) results.messages.push(`Starting instance ${PM2_INSTANCE_PREFIX}${name}...`);
    await safeRunCommand("pm2", ["start", `${PM2_INSTANCE_PREFIX}${name}`], `Failed to start PM2 process ${PM2_INSTANCE_PREFIX}${name}`);
    results.success = true;
    results.messages.push(`Instance "${name}" reset and started.`);
  } catch (error) {
    results.messages.push(`Error during internal reset instance: ${error.message}`);
    results.error = error.message;
    if (completeLogging) console.error(error.stack);
  }
  return results;
}

async function _internalResetAdminPassword(payload) {
  const { name, adminEmail, adminPassword } = payload;
  const results = { success: false, messages: [], error: null };
  try {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      results.error = `Instance "${name}" not found.`;
      results.messages.push(results.error);
      return results;
    }
    if (!adminEmail || !adminPassword) {
      results.error = "Admin email and new password are required.";
      results.messages.push(results.error);
      return results;
    }
    const instance = config.instances[name];
    const dataDir = instance.dataDir;
    const adminUpdateArgs = ["superuser", "update", adminEmail, adminPassword, "--dir", dataDir];
    if (completeLogging) results.messages.push(`Attempting to reset admin password for ${adminEmail} on instance ${name}...`);
    const result = await safeRunCommand(POCKETBASE_EXEC_PATH, adminUpdateArgs, "Failed to reset superuser (admin) password via CLI.");
    if (result?.stdout?.includes("Successfully updated superuser")) {
      if (completeLogging) results.messages.push(result.stdout.trim());
      results.messages.push(`Superuser (admin) password for ${adminEmail} reset successfully!`);
      results.success = true;
    } else {
      results.error = "Admin password reset command did not confirm success.";
      results.messages.push(results.error);
      if (completeLogging && result.stdout) results.messages.push(`Stdout: ${result.stdout}`);
      if (completeLogging && result.stderr) results.messages.push(`Stderr: ${result.stderr}`);
    }
  } catch (error) {
    results.messages.push(`Error during internal admin password reset: ${error.message}`);
    results.error = error.message;
    if (completeLogging) console.error(error.stack);
  }
  return results;
}

async function _internalRenewCertificates(payload) {
  const { instanceName, force } = payload;
  const results = { success: false, messages: [], error: null };
  if (!shell.which("certbot")) {
    results.error = "Certbot command not found. Please install Certbot first.";
    results.messages.push(results.error);
    return results;
  }

  const certbotArgs = ["renew"];
  let baseMessage;

  if (instanceName && instanceName.toLowerCase() !== "all") {
    const config = await getInstancesConfig();
    const instance = config.instances[instanceName];
    if (!instance || !instance.useHttps) {
      results.error = `Instance "${instanceName}" not found or does not use HTTPS.`;
      results.messages.push(results.error);
      return results;
    }
    certbotArgs.push("--cert-name", instance.domain);
    baseMessage = `Attempted certificate renewal for ${instance.domain}.`;
  } else {
    baseMessage = "Attempted renewal for all managed certificates.";
  }
  if (force) {
    certbotArgs.push("--force-renewal");
  }

  try {
    if (completeLogging) results.messages.push(`Executing: sudo certbot ${certbotArgs.join(" ")}`);
    await safeRunCommand("sudo", ["certbot", ...certbotArgs], "Certbot renewal command failed.");
    if (completeLogging) results.messages.push(baseMessage);

    if (completeLogging) results.messages.push("Reloading Nginx to apply any changes...");
    const nginxReloadResult = await reloadNginx();
    if (!nginxReloadResult.success) {
      results.messages.push(`Nginx reload after cert renewal failed: ${nginxReloadResult.message}`);
      throw nginxReloadResult.error || new Error(nginxReloadResult.message);
    }
    if (completeLogging) {
      results.messages.push(nginxReloadResult.message);
    }
    results.success = true;
    results.messages.push("Certificate renewal process completed.");
  } catch (error) {
    results.error = `Certificate renewal process failed: ${error.message}`;
    results.messages.push(results.error);
    results.messages.push("Check Certbot logs in /var/log/letsencrypt/ for more details.");
    if (completeLogging) console.error(error.stack);
  }
  return results;
}

async function _internalUpdatePocketBaseExecutable() {
  const results = { success: false, messages: [], error: null };
  try {
    if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      results.error = "PocketBase executable not found. Run 'setup' or 'configure' first.";
      results.messages.push(results.error);
      return results;
    }
    if (completeLogging) results.messages.push(`Running: ${POCKETBASE_EXEC_PATH} update`);
    const updateResult = await safeRunCommand(POCKETBASE_EXEC_PATH, ["update"], "PocketBase update command failed.", false, { cwd: POCKETBASE_BIN_DIR });
    if (completeLogging) {
      results.messages.push("PocketBase executable update process finished.");
      if (updateResult.stdout) results.messages.push(`Stdout: ${updateResult.stdout}`);
      if (updateResult.stderr) results.messages.push(`Stderr: ${updateResult.stderr}`);
    }

    if (completeLogging) results.messages.push("Restarting all PocketBase instances via PM2...");
    const instancesConf = await getInstancesConfig();
    const instanceNames = Object.keys(instancesConf.instances);

    const restartPromises = instanceNames.map((instName) =>
      safeRunCommand("pm2", ["restart", `${PM2_INSTANCE_PREFIX}${instName}`], `Failed to restart instance ${PM2_INSTANCE_PREFIX}${instName}`)
        .then(() => {
          if (completeLogging) results.messages.push(`Instance ${PM2_INSTANCE_PREFIX}${instName} restarted.`);
          return true;
        })
        .catch((e) => {
          results.messages.push(`Failed to restart instance ${PM2_INSTANCE_PREFIX}${instName}: ${e.message}`);
          return false;
        }),
    );

    const restartResults = await Promise.all(restartPromises);
    const allRestarted = restartResults.every(Boolean);

    if (allRestarted) {
      results.messages.push("All instances processed for restarting.");
    } else {
      results.messages.push("Some instances may not have restarted correctly. Check PM2 logs and errors above.");
    }
    results.success = true;
  } catch (error) {
    results.error = `Failed to run PocketBase update process: ${error.message}`;
    results.messages.push(results.error);
    if (completeLogging) console.error(error.stack);
  }
  return results;
}

async function _internalUpdateEcosystemAndReloadPm2() {
  try {
    const updateRes = await updatePm2EcosystemFile();
    if (completeLogging && updateRes.success) console.log(updateRes.message);

    const reloadResult = await reloadPm2();
    if (completeLogging && reloadResult.success) console.log(reloadResult.message);

    if (!reloadResult.success) {
      return {
        success: false,
        error: "Failed to reload PM2 after ecosystem update.",
        messages: ["PM2 ecosystem file updated, but PM2 reload failed.", reloadResult.message],
      };
    }
    return {
      success: true,
      messages: ["PM2 ecosystem file updated and PM2 reloaded successfully."],
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      messages: [`Error updating ecosystem/reloading PM2: ${error.message}`],
    };
  }
}

async function _internalSetDefaultCertbotEmail(payload) {
  const { email } = payload;
  if (email !== null && typeof email !== "string") {
    return {
      success: false,
      error: "Invalid payload: 'email' must be a valid email string, empty string, or null.",
      messages: ["Invalid payload for setting Certbot email."],
    };
  }
  if (email && !EMAIL_REGEX.test(email)) {
    return {
      success: false,
      error: "Invalid payload: 'email' must be a valid email format.",
      messages: ["Invalid email format for Certbot email."],
    };
  }
  try {
    const cliConfig = await getCliConfig();
    cliConfig.defaultCertbotEmail = email || null;
    await saveCliConfig(cliConfig);
    return {
      success: true,
      messages: [`Default Certbot email set to ${cliConfig.defaultCertbotEmail || "not set"}.`],
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      messages: [`Error setting default Certbot email: ${error.message}`],
    };
  }
}

const validateInstanceName = (input) => NAME_REGEX.test(input) || "Invalid name format.";
const validateEmail = (input) => EMAIL_REGEX.test(input) || "Please enter a valid email.";
const validatePort = (input) => (Number.isInteger(input) && input > 1024 && input < 65535) || "Invalid port.";
const validateSize = (input) => SIZE_REGEX.test(input) || "Please enter a value like 100M or 1G.";
const validateIpList = (input, includeLocalhost) => {
  if (!input.trim() && !includeLocalhost) {
    return "Please enter at least one IP address or CIDR range.";
  }
  if (!input.trim()) return true;
  const ips = input
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
  const invalidIps = ips.filter((ip) => !IP_REGEX.test(ip));
  return invalidIps.length === 0 || `Invalid IP address(es): ${invalidIps.join(", ")}. Use format: 192.168.1.1 or 10.0.0.0/24`;
};

program
  .command("configure")
  .description("Set or view CLI configurations (e.g., default Certbot email, logging).")
  .action(async () => {
    await ensureBaseSetup();
    const cliConfig = await getCliConfig();
    const choices = [{ name: `Default Certbot Email: ${cliConfig.defaultCertbotEmail || "Not set"}`, value: "setEmail" }, { name: `Enable complete logging: ${cliConfig.completeLogging ? "Yes" : "No"}`, value: "setLogging" }, new inquirer.Separator(), { name: "View current JSON config", value: "viewConfig" }, { name: "Exit", value: "exit" }];
    const { action } = await inquirer.prompt([{ type: "list", name: "action", message: "CLI Configuration:", choices }]);

    switch (action) {
      case "setEmail": {
        const { email } = await inquirer.prompt([
          {
            type: "input",
            name: "email",
            message: "Enter new default Certbot email (leave blank to clear):",
            default: cliConfig.defaultCertbotEmail,
          },
        ]);
        const result = await _internalSetDefaultCertbotEmail({ email });
        for (const msg of result.messages) {
          console.log(result.success ? chalk.green(msg) : chalk.red(msg));
        }
        break;
      }
      case "setLogging": {
        const { enableLogging } = await inquirer.prompt([
          {
            type: "confirm",
            name: "enableLogging",
            message: "Enable complete logging (show all commands and outputs)?",
            default: cliConfig.completeLogging || false,
          },
        ]);
        cliConfig.completeLogging = enableLogging;
        await saveCliConfig(cliConfig);
        completeLogging = enableLogging;
        console.log(chalk.green(`Complete logging is now ${enableLogging ? "enabled" : "disabled"}.`));
        break;
      }
      case "viewConfig":
        console.log(chalk.cyan("Current CLI Configuration:"));
        console.log(JSON.stringify(cliConfig, null, 2));
        return;
      case "exit":
        console.log(chalk.blue("Exiting configuration."));
        return;
    }
    if (action !== "setLogging" && action !== "viewConfig" && action !== "exit" && action !== "setEmail") {
      console.log(chalk.green("Configuration updated."));
    }
  });

program
  .command("setup")
  .description("Initial setup: creates directories and downloads PocketBase.")
  .option("-v, --version <version>", "Specify PocketBase version to download for setup")
  .action(async (options) => {
    console.log(chalk.bold.cyan("Starting PocketBase Manager Setup..."));
    await ensureBaseSetup();
    const dlResult = await downloadPocketBaseIfNotExists(options.version, true);
    if (dlResult && dlResult.success === false) {
      console.error(chalk.red(`PocketBase download failed: ${dlResult.message}`));
    } else {
      console.log(chalk.bold.green("Setup complete!"));
      console.log(chalk.blue("You can now add your first PocketBase instance using: sudo pb-manager add"));
    }
  });

program
  .command("add")
  .alias("create")
  .description("Add a new PocketBase instance")
  .action(async () => {
    const cliConfig = await getCliConfig();
    await ensureBaseSetup();

    if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      console.log(chalk.yellow("PocketBase executable not found. Attempting to download..."));
      const dlResult = await downloadPocketBaseIfNotExists(null, true);
      if (!dlResult.success) {
        console.error(chalk.red(`PocketBase download failed: ${dlResult.message}. Cannot add instance.`));
        return;
      }
      if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
        console.error(chalk.red("PocketBase download seems to have failed despite no error. Cannot add instance."));
        return;
      }
    }

    const initialAnswers = await inquirer.prompt([
      {
        type: "input",
        name: "name",
        message: "Instance name (e.g., my-app, no spaces):",
        validate: validateInstanceName,
      },
      {
        type: "input",
        name: "domain",
        message: "Domain/subdomain for this instance (e.g., app.example.com):",
        validate: (input) => input.length > 0 || "Domain cannot be empty.",
      },
      {
        type: "number",
        name: "port",
        message: "Internal port for this instance (e.g., 8091):",
        default: 8090 + Math.floor(Math.random() * 100),
        validate: validatePort,
      },
      {
        type: "confirm",
        name: "useHttp2",
        message: "Enable HTTP/2 in Nginx config?",
        default: true,
      },
      {
        type: "list",
        name: "clientMaxBodySizeOption",
        message: "Set 'client_max_body_size' in Nginx config?",
        choices: [
          { name: "20MB (images, typical)", value: "20M" },
          { name: "100MB (videos, larger files)", value: "100M" },
          { name: "500MB (very large files)", value: "500M" },
          { name: "Custom", value: "custom" },
          { name: "None (use Nginx default)", value: null },
        ],
        default: "20M",
      },
      {
        type: "input",
        name: "customClientMaxBodySize",
        message: "Enter custom max body size (e.g., 1G, 250M):",
        when: (answers) => answers.clientMaxBodySizeOption === "custom",
        validate: validateSize,
      },
    ]);

    const config = await getInstancesConfig();
    if (config.instances[initialAnswers.name]) {
      console.error(chalk.red(`Instance "${initialAnswers.name}" already exists.`));
      return;
    }
    for (const instName in config.instances) {
      if (config.instances[instName].port === initialAnswers.port) {
        console.error(chalk.red(`Port ${initialAnswers.port} is already in use by another managed instance.`));
        return;
      }
      if (config.instances[instName].domain === initialAnswers.domain) {
        console.error(chalk.red(`Domain ${initialAnswers.domain} is already in use by another managed instance.`));
        return;
      }
    }

    const clientMaxBodySize = initialAnswers.clientMaxBodySizeOption === "custom" ? initialAnswers.customClientMaxBodySize : initialAnswers.clientMaxBodySizeOption;

    let attemptGlobalClientMaxBodySize = false;
    if (clientMaxBodySize) {
      console.log(chalk.yellow("\nNote: For some Nginx versions, 'client_max_body_size' in server/location blocks might not be fully effective."));
      console.log(chalk.yellow(`It may also need to be set in the main 'http' block of your Nginx configuration (typically ${NGINX_GLOBAL_CONF_PATH}).`));

      const { confirmAddToHttpBlock } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmAddToHttpBlock",
          message: `Do you want to attempt to add 'client_max_body_size ${clientMaxBodySize};' to the http block in ${NGINX_GLOBAL_CONF_PATH} if it's not already present? (A backup will be created. If it's present with a different value, it will NOT be changed.)`,
          default: false,
        },
      ]);
      attemptGlobalClientMaxBodySize = confirmAddToHttpBlock;
    }

    let allowedIps = [];
    let adminOnlyRestriction = false;

    const { configureIpRestriction } = await inquirer.prompt([
      {
        type: "confirm",
        name: "configureIpRestriction",
        message: "Do you want to set custom allowed IP addresses in the Nginx server?",
        default: false,
      },
    ]);

    if (configureIpRestriction) {
      console.log(chalk.yellow(`\nNote: Local services on this server can always access PocketBase directly via 127.0.0.1:${initialAnswers.port} (bypassing Nginx).`));
      console.log(chalk.yellow("The IP restrictions below only apply to requests coming through Nginx.\n"));

      const { restrictionScope } = await inquirer.prompt([
        {
          type: "list",
          name: "restrictionScope",
          message: "What do you want to restrict?",
          choices: [
            { name: "Admin UI only (/_/) - API endpoints remain open for all", value: "admin" },
            { name: "Entire instance - Both admin UI and API endpoints", value: "all" },
          ],
          default: "admin",
        },
      ]);

      adminOnlyRestriction = restrictionScope === "admin";

      const { includeLocalhost } = await inquirer.prompt([
        {
          type: "confirm",
          name: "includeLocalhost",
          message: "Automatically allow localhost (127.0.0.1) through Nginx? (Recommended if local services need to use the domain/HTTPS)",
          default: true,
        },
      ]);

      const { ipAddresses } = await inquirer.prompt([
        {
          type: "input",
          name: "ipAddresses",
          message: "Enter additional allowed IP addresses (comma-separated, e.g., 192.168.1.1, 10.0.0.0/24, 203.0.113.50):",
          validate: (input) => validateIpList(input, includeLocalhost),
        },
      ]);

      const userIps = ipAddresses.trim()
        ? ipAddresses
            .split(",")
            .map((ip) => ip.trim())
            .filter(Boolean)
        : [];

      allowedIps = includeLocalhost ? ["127.0.0.1", ...userIps] : userIps;

      const scopeText = adminOnlyRestriction ? "admin UI only" : "entire instance";
      console.log(chalk.blue(`IP restriction (${scopeText}) will be configured for: ${allowedIps.join(", ")}`));
    }

    const { optimizeRealtime } = await inquirer.prompt([
      {
        type: "confirm",
        name: "optimizeRealtime",
        message: "Optimize PocketBase's realtime path (/api/realtime) in Nginx? (Recommended if using SSE/realtime features)",
        default: true,
      },
    ]);

    let emailToUseForCertbot = cliConfig.defaultCertbotEmail;
    const httpsAnswers = await inquirer.prompt([
      {
        type: "confirm",
        name: "useHttps",
        message: "Configure HTTPS (Certbot)?",
        default: true,
      },
      {
        type: "confirm",
        name: "useDefaultEmail",
        message: `Use default email (${cliConfig.defaultCertbotEmail}) for Let's Encrypt?`,
        default: true,
        when: (answers) => answers.useHttps && cliConfig.defaultCertbotEmail,
      },
      {
        type: "input",
        name: "emailForCertbot",
        message: "Enter email for Let's Encrypt:",
        when: (answers) => answers.useHttps && (!cliConfig.defaultCertbotEmail || !answers.useDefaultEmail),
        validate: (input) => EMAIL_REGEX.test(input) || "Valid email required.",
        default: (answers) => (!cliConfig.defaultCertbotEmail || !answers.useDefaultEmail ? undefined : cliConfig.defaultCertbotEmail),
      },
      {
        type: "confirm",
        name: "autoRunCertbot",
        message: "Attempt to automatically run Certbot now to obtain the SSL certificate?",
        default: true,
        when: (answers) => answers.useHttps,
      },
    ]);

    if (httpsAnswers.useHttps) {
      const dnsValid = await validateDnsRecords(initialAnswers.domain);
      if (!dnsValid) {
        const { proceedAnyway } = await inquirer.prompt([
          {
            type: "confirm",
            name: "proceedAnyway",
            message: chalk.yellow(`DNS validation failed for ${initialAnswers.domain}. Certbot will likely fail. Do you want to proceed with the setup (you might need to fix DNS and run Certbot manually later, or use HTTP only)?`),
            default: false,
          },
        ]);
        if (!proceedAnyway) {
          console.log(chalk.yellow("Instance setup aborted by user due to DNS issues."));
          return;
        }
        console.log(chalk.yellow("Proceeding with setup despite DNS validation issues. HTTPS/Certbot might fail."));
      }
      if (cliConfig.defaultCertbotEmail && httpsAnswers.useDefaultEmail) {
        emailToUseForCertbot = cliConfig.defaultCertbotEmail;
      } else {
        emailToUseForCertbot = httpsAnswers.emailForCertbot;
      }
      if (!emailToUseForCertbot) {
        console.error(chalk.red("Certbot email is required for HTTPS setup. Aborting."));
        return;
      }
    }

    const addPayload = {
      name: initialAnswers.name,
      domain: initialAnswers.domain,
      port: initialAnswers.port,
      useHttps: httpsAnswers.useHttps,
      emailForCertbot: httpsAnswers.useHttps ? emailToUseForCertbot : null,
      useHttp2: initialAnswers.useHttp2,
      clientMaxBodySize: clientMaxBodySize,
      autoRunCertbot: httpsAnswers.useHttps ? httpsAnswers.autoRunCertbot : false,
      attemptGlobalClientMaxBodySize,
      allowedIps,
      adminOnlyRestriction,
      optimizeRealtime,
    };

    const result = await _internalAddInstance(addPayload);

    for (const msg of result.messages) {
      console.log(chalk.blue(msg));
    }

    if (!result.success) {
      console.error(chalk.red(`Failed to add instance: ${result.error || "Unknown error during add operation."}`));
      return;
    }

    let adminCreatedViaCli = false;
    const { createAdminCli } = await inquirer.prompt([
      {
        type: "confirm",
        name: "createAdminCli",
        message: "Do you want to create a superuser (admin) account for this instance via CLI now?",
        default: true,
      },
    ]);

    if (createAdminCli) {
      const adminCredentials = await inquirer.prompt([
        {
          type: "input",
          name: "adminEmail",
          message: "Enter admin email:",
          validate: validateEmail,
        },
        {
          type: "password",
          name: "adminPassword",
          message: "Enter admin password (min 8 chars):",
          mask: "*",
          validate: (input) => input.length >= 8 || "Password must be at least 8 characters.",
        },
      ]);
      const instanceDataDir = path.join(INSTANCES_DATA_BASE_DIR, initialAnswers.name);
      const migrationsDir = path.join(instanceDataDir, "pb_migrations");
      const adminCreateArgs = ["superuser", "create", adminCredentials.adminEmail, adminCredentials.adminPassword, "--dir", instanceDataDir, "--migrationsDir", migrationsDir];
      if (completeLogging) {
        console.log(chalk.blue("\nAttempting to create superuser (admin) account via CLI..."));
      }
      try {
        const adminCmdResult = await safeRunCommand(POCKETBASE_EXEC_PATH, adminCreateArgs, "Failed to create superuser (admin) account via CLI.");
        if (adminCmdResult?.stdout?.includes("Successfully created new superuser") && completeLogging) {
          console.log(adminCmdResult.stdout.trim());
        }
        console.log(chalk.green(`Superuser (admin) account for ${adminCredentials.adminEmail} created successfully!`));
        adminCreatedViaCli = true;
      } catch (e) {
        console.error(chalk.red(`Superuser (admin) account creation via CLI failed: ${e.message}. Please try creating it via the web UI.`));
      }
    }

    console.log(chalk.bold.green(`\nInstance "${initialAnswers.name}" added!`));
    const protocol = result.instance.useHttps && result.certbotSuccess ? "https" : "http";
    const publicBaseUrl = `${protocol}://${result.instance.domain}`;
    const localAdminUrl = `http://127.0.0.1:${result.instance.port}/_/`;
    console.log(chalk.blue("\nInstance Details:"));
    console.log(chalk.blue(`  Public URL: ${publicBaseUrl}/_/`));
    if (!adminCreatedViaCli) {
      console.log(chalk.yellow("\nIMPORTANT NEXT STEP: Create your PocketBase Admin Account"));
      console.log(chalk.yellow("1. Visit one of the URLs below in your browser to create the first admin user:"));
      console.log(chalk.yellow(`   - Option A (Recommended if Nginx/HTTPS is working): ${publicBaseUrl}/_/`));
      console.log(chalk.yellow(`   - Option B (Direct access, may require SSH port forwarding for headless servers): ${localAdminUrl}`));
      console.log(chalk.cyan(`     (For SSH port forwarding: ssh -L ${initialAnswers.port}:127.0.0.1:${initialAnswers.port} your_user@your_server_ip then open ${localAdminUrl} in your local browser)`));
    } else {
      console.log(chalk.yellow("\nYou can now access the admin panel at:"));
      console.log(chalk.yellow(`   - ${publicBaseUrl}/_/`));
      console.log(chalk.yellow(`   - Or locally (if needed for direct access): ${localAdminUrl}`));
    }
    if (result.instance.useHttps && !result.certbotSuccess && httpsAnswers.autoRunCertbot) {
      console.log(chalk.red("\nCertbot failed. The instance might only be available via HTTP or not at all if Nginx config expects SSL."));
      console.log(chalk.red("You might need to use the local URL for admin access or fix the Nginx/Certbot issue."));
      console.log(chalk.red(`Try: sudo certbot --nginx -d ${initialAnswers.domain} -m ${emailToUseForCertbot}`));
    }
    console.log(chalk.yellow("\nOnce logged in, you can manage your collections and settings."));
  });

program
  .command("update-pocketbase")
  .description("Updates the PocketBase executable using 'pocketbase update' and restarts all instances.")
  .action(async () => {
    console.log(chalk.bold.cyan("Attempting to update PocketBase executable..."));
    if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      console.error(chalk.red("PocketBase executable not found. Run 'setup' or 'configure' to set a version and download."));
      return;
    }
    const { confirmUpdate } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmUpdate",
        message: `This will run '${POCKETBASE_EXEC_PATH} update' to fetch the latest PocketBase binary and then restart ALL managed instances. Do you want to proceed?`,
        default: true,
      },
    ]);
    if (!confirmUpdate) {
      console.log(chalk.yellow("PocketBase update cancelled by user."));
      return;
    }

    const result = await _internalUpdatePocketBaseExecutable();

    for (const msg of result.messages) {
      console.log(result.success ? chalk.green(msg) : chalk.yellow(msg));
    }

    if (!result.success) {
      console.error(chalk.red(`PocketBase update process failed: ${result.error || "Unknown error."}`));
    } else {
      console.log(chalk.bold.green("PocketBase update and instance restarts completed."));
    }
  });

program
  .command("remove <name>")
  .description("Remove a PocketBase instance")
  .action(async (name) => {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      console.error(chalk.red(`Instance "${name}" not found.`));
      return;
    }
    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: `Are you sure you want to remove instance "${name}"? This will stop it, remove its PM2 entry, and Nginx config. Data directory will NOT be deleted automatically by this step.`,
        default: false,
      },
    ]);
    if (!confirm) {
      console.log(chalk.yellow("Removal cancelled."));
      return;
    }
    const { confirmTyped } = await inquirer.prompt([
      {
        type: "input",
        name: "confirmTyped",
        message: `To confirm removal of instance "${name}", please type its name again:`,
      },
    ]);
    if (confirmTyped !== name) {
      console.log(chalk.yellow("Instance name did not match. Removal cancelled."));
      return;
    }

    let deleteData = false;
    const { confirmDeleteData } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmDeleteData",
        message: `Do you want to permanently delete the data directory ${config.instances[name].dataDir} for the removed instance "${name}"? ${chalk.bold.red("THIS CANNOT BE UNDONE.")}`,
        default: false,
      },
    ]);
    if (confirmDeleteData) {
      const { confirmTypedDeleteData } = await inquirer.prompt([
        {
          type: "input",
          name: "confirmTypedDeleteData",
          message: `To confirm PERMANENT DELETION of data for "${name}", type the instance name again:`,
        },
      ]);
      if (confirmTypedDeleteData === name) {
        deleteData = true;
      } else {
        console.log(chalk.yellow("Instance name did not match for data deletion. Data directory NOT deleted."));
      }
    }

    const result = await _internalRemoveInstance({ name, deleteData });

    for (const msg of result.messages) {
      console.log(chalk.blue(msg));
    }

    if (result.success) {
      console.log(chalk.bold.green(`Instance "${name}" removed process completed.`));
    } else {
      console.error(chalk.red(`Failed to remove instance: ${result.error || "Unknown error."}`));
    }
  });

program
  .command("list")
  .description("List all managed PocketBase instances")
  .option("--json", "Output in JSON format")
  .action(async (options) => {
    const instancesList = await _internalListInstances();
    if (instancesList.length === 0) {
      if (options.json) {
        console.log(JSON.stringify([], null, 2));
      } else {
        console.log(chalk.yellow("No instances configured yet. Use 'pb-manager add'."));
      }
      return;
    }
    if (options.json) {
      console.log(JSON.stringify(instancesList, null, 2));
      return;
    }
    console.log(chalk.bold.cyan("Managed PocketBase Instances:"));
    for (const inst of instancesList) {
      console.log(`\n  ${chalk.bold(inst.name)}:\n    Domain: ${chalk.green(inst.domain)} (${inst.protocol})\n    Public URL: ${chalk.green(inst.publicUrl)}\n    Internal Port: ${chalk.yellow(inst.internalPort)}\n    Data Directory: ${inst.dataDirectory}\n    PM2 Status: ${inst.pm2Status === PM2_STATUS_ONLINE ? chalk.green(inst.pm2Status) : chalk.red(inst.pm2Status)}\n    Admin URL (local): ${inst.adminURL}\n    Certificate expires in: ${inst.certExpiryDays} day(s)`);
    }
  });

async function handlePm2Action(action, instanceNameOrAll) {
  const config = await getInstancesConfig();
  const instanceNames = Object.keys(config.instances);
  let targets;

  if (instanceNameOrAll?.toLowerCase() === "all") {
    targets = instanceNames;
  } else if (instanceNameOrAll) {
    if (!config.instances[instanceNameOrAll]) {
      console.error(chalk.red(`Instance "${instanceNameOrAll}" not found.`));
      return;
    }
    targets = [instanceNameOrAll];
  } else {
    console.log(chalk.yellow(`Please specify an instance name or 'all'. Usage: pb-manager ${action} <name|all>`));
    return;
  }

  if (targets.length === 0) {
    console.log(chalk.yellow(`No instances configured to ${action}.`));
    return;
  }

  const capitalizedAction = action.charAt(0).toUpperCase() + action.slice(1);
  if (completeLogging || targets.length === 1) {
    console.log(chalk.blue(`${capitalizedAction}ing ${targets.length > 1 ? "all managed" : ""} instance(s)...`));
  }

  let allProcessedSuccessfully = true;
  for (const targetName of targets) {
    try {
      await safeRunCommand("pm2", [action, `${PM2_INSTANCE_PREFIX}${targetName}`], `Failed to ${action} instance ${PM2_INSTANCE_PREFIX}${targetName}`);
      if (completeLogging || targets.length === 1) {
        console.log(chalk.green(`Instance ${PM2_INSTANCE_PREFIX}${targetName} ${action}ed.`));
      }
    } catch (e) {
      console.error(chalk.red(`Failed to ${action} instance ${PM2_INSTANCE_PREFIX}${targetName}: ${e.message}`));
      allProcessedSuccessfully = false;
    }
  }

  if (allProcessedSuccessfully && targets.length > 1) {
    console.log(chalk.bold.green(`All instances processed for ${action}ing.`));
  } else if (!allProcessedSuccessfully) {
    console.log(chalk.bold.yellow(`Some instances may not have ${action}ed correctly. Check PM2 logs.`));
  }
}

program
  .command("start [name]")
  .description("Start a specific PocketBase instance or all instances via PM2")
  .action(async (name) => {
    await handlePm2Action("start", name);
  });

program
  .command("stop [name]")
  .description("Stop a specific PocketBase instance or all instances via PM2")
  .action(async (name) => {
    await handlePm2Action("stop", name);
  });

program
  .command("restart [name]")
  .description("Restart a specific PocketBase instance or all instances via PM2")
  .action(async (name) => {
    await handlePm2Action("restart", name);
  });

program
  .command("logs <name>")
  .description("Show logs for a specific PocketBase instance from PM2")
  .action((name) => {
    console.log(chalk.blue(`Displaying logs for ${PM2_INSTANCE_PREFIX}${name}. Press Ctrl+C to exit.`));
    shell.exec(`pm2 logs ${PM2_INSTANCE_PREFIX}${name} --lines 50`);
  });

program
  .command("update-ecosystem")
  .description("Regenerate the PM2 ecosystem file and reload PM2")
  .action(async () => {
    const result = await _internalUpdateEcosystemAndReloadPm2();
    for (const msg of result.messages) {
      console.log(result.success ? chalk.green(msg) : chalk.red(msg));
    }
    if (!result.success) {
      console.error(chalk.red(`Failed to update ecosystem: ${result.error || "Unknown error."}`));
    }
  });

program
  .command("reset <name>")
  .description("Reset a PocketBase instance (delete all data and optionally create a new admin account)")
  .action(async (name) => {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      console.error(chalk.red(`Instance "${name}" not found.`));
      return;
    }
    const instance = config.instances[name];
    const dataDir = instance.dataDir;
    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: `Are you sure you want to reset instance "${name}"? This will ${chalk.red.bold("DELETE ALL DATA")} in ${dataDir} and start from zero. This action cannot be undone.`,
        default: false,
      },
    ]);
    if (!confirm) {
      console.log(chalk.yellow("Reset cancelled."));
      return;
    }
    const { confirmTyped } = await inquirer.prompt([
      {
        type: "input",
        name: "confirmTyped",
        message: `To confirm PERMANENT DELETION of all data for instance "${name}", please type its name again:`,
      },
    ]);
    if (confirmTyped !== name) {
      console.log(chalk.yellow("Instance name did not match. Reset cancelled."));
      return;
    }

    let adminPayload = { createAdmin: false };
    const { createAdminCli } = await inquirer.prompt([
      {
        type: "confirm",
        name: "createAdminCli",
        message: "Do you want to create a new superuser (admin) account for this reset instance via CLI now?",
        default: true,
      },
    ]);
    if (createAdminCli) {
      const adminCredentials = await inquirer.prompt([
        {
          type: "input",
          name: "adminEmail",
          message: "Enter admin email:",
          validate: validateEmail,
        },
        {
          type: "password",
          name: "adminPassword",
          message: "Enter admin password (min 8 chars):",
          mask: "*",
          validate: (input) => input.length >= 8 || "Password must be at least 8 characters.",
        },
      ]);
      adminPayload = {
        createAdmin: true,
        adminEmail: adminCredentials.adminEmail,
        adminPassword: adminCredentials.adminPassword,
      };
    }

    const resetPayload = { name, ...adminPayload };
    const result = await _internalResetInstance(resetPayload);

    for (const msg of result.messages) {
      console.log(result.success ? chalk.green(msg) : chalk.yellow(msg));
    }

    if (!result.success) {
      console.error(chalk.red(`Failed to reset instance: ${result.error || "Unknown error."}`));
      process.exitCode = 1;
    } else {
      console.log(chalk.bold.green(`Instance "${name}" reset process completed.`));
    }
  });

program
  .command("reset-admin <name>")
  .description("Reset the admin password for a PocketBase instance")
  .action(async (name) => {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      console.error(chalk.red(`Instance "${name}" not found.`));
      return;
    }

    const adminCredentials = await inquirer.prompt([
      {
        type: "input",
        name: "adminEmail",
        message: "Enter admin email to reset:",
        validate: validateEmail,
      },
      {
        type: "password",
        name: "adminPassword",
        message: "Enter new admin password (min 8 chars):",
        mask: "*",
        validate: (input) => input.length >= 8 || "Password must be at least 8 characters.",
      },
    ]);

    const resetPayload = {
      name,
      adminEmail: adminCredentials.adminEmail,
      adminPassword: adminCredentials.adminPassword,
    };
    const result = await _internalResetAdminPassword(resetPayload);

    for (const msg of result.messages) {
      console.log(result.success ? chalk.green(msg) : chalk.red(msg));
    }

    if (!result.success) {
      console.error(chalk.red(`Failed to reset admin password: ${result.error || "Unknown error."}`));
    }
  });

program
  .command("update-ip-restrictions <name>")
  .description("Update IP restrictions for an existing PocketBase instance")
  .action(async (name) => {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      console.error(chalk.red(`Instance "${name}" not found.`));
      return;
    }

    const instance = config.instances[name];
    const currentIps = instance.allowedIps || [];
    const currentAdminOnly = instance.adminOnlyRestriction || false;

    console.log(chalk.cyan(`\nUpdating IP restrictions for instance "${name}"`));
    console.log(chalk.blue(`Domain: ${instance.domain}`));
    console.log(chalk.blue(`Current allowed IPs: ${currentIps.length > 0 ? currentIps.join(", ") : "None (open access)"}`));
    console.log(chalk.blue(`Current restriction scope: ${currentAdminOnly ? "Admin UI only (/_/)" : "Entire instance"}`));
    console.log(chalk.yellow(`\nNote: Local services can always access PocketBase directly via 127.0.0.1:${instance.port} (bypassing Nginx).`));

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "What would you like to do?",
        choices: [
          { name: "Set new IP restrictions", value: "set" },
          { name: "Add IPs to existing list", value: "add" },
          { name: "Remove all IP restrictions (open access)", value: "remove" },
          { name: "Cancel", value: "cancel" },
        ],
      },
    ]);

    if (action === "cancel") {
      console.log(chalk.yellow("Operation cancelled."));
      return;
    }

    let newAllowedIps = [];
    let newAdminOnlyRestriction = currentAdminOnly;

    if (action === "remove") {
      const { confirmRemove } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmRemove",
          message: "Are you sure you want to remove all IP restrictions? The instance will be accessible from any IP.",
          default: false,
        },
      ]);
      if (!confirmRemove) {
        console.log(chalk.yellow("Operation cancelled."));
        return;
      }
      newAllowedIps = [];
      newAdminOnlyRestriction = false;
    } else {
      const { restrictionScope } = await inquirer.prompt([
        {
          type: "list",
          name: "restrictionScope",
          message: "What do you want to restrict?",
          choices: [
            { name: "Admin UI only (/_/) - API endpoints remain open for all", value: "admin" },
            { name: "Entire instance - Both admin UI and API endpoints", value: "all" },
          ],
          default: currentAdminOnly ? "admin" : "all",
        },
      ]);

      newAdminOnlyRestriction = restrictionScope === "admin";

      const { includeLocalhost } = await inquirer.prompt([
        {
          type: "confirm",
          name: "includeLocalhost",
          message: "Include localhost (127.0.0.1) in allowed IPs? (Recommended if local services need to use the domain/HTTPS)",
          default: currentIps.includes("127.0.0.1") || action === "set",
        },
      ]);

      const existingNonLocalhost = currentIps.filter((ip) => ip !== "127.0.0.1");
      const defaultIps = action === "add" ? "" : existingNonLocalhost.join(", ");

      const { ipAddresses } = await inquirer.prompt([
        {
          type: "input",
          name: "ipAddresses",
          message: action === "add" ? "Enter IP addresses to add (comma-separated, e.g., 192.168.1.1, 10.0.0.0/24):" : "Enter allowed IP addresses (comma-separated, e.g., 192.168.1.1, 10.0.0.0/24):",
          default: defaultIps,
          validate: (input) => validateIpList(input, includeLocalhost),
        },
      ]);

      const userIps = ipAddresses.trim()
        ? ipAddresses
            .split(",")
            .map((ip) => ip.trim())
            .filter(Boolean)
        : [];

      if (action === "add") {
        const allIps = new Set([...currentIps, ...userIps]);
        if (includeLocalhost) allIps.add("127.0.0.1");
        else allIps.delete("127.0.0.1");
        newAllowedIps = Array.from(allIps);
      } else {
        newAllowedIps = includeLocalhost ? ["127.0.0.1", ...userIps] : userIps;
      }
    }

    instance.allowedIps = newAllowedIps;
    instance.adminOnlyRestriction = newAdminOnlyRestriction;
    await saveInstancesConfig(config);

    console.log(chalk.blue("\nRegenerating Nginx configuration..."));
    try {
      const nginxResult = await generateNginxConfig(name, instance.domain, instance.port, instance.useHttps, instance.useHttp2, instance.clientMaxBodySize, false, newAllowedIps, newAdminOnlyRestriction, instance.optimizeRealtime || false);

      if (!nginxResult.success) {
        console.error(chalk.red(`Failed to generate Nginx config: ${nginxResult.message}`));
        return;
      }

      const reloadResult = await reloadNginx();
      if (!reloadResult.success) {
        console.error(chalk.red(`Failed to reload Nginx: ${reloadResult.message}`));
        return;
      }

      console.log(chalk.bold.green(`\nIP restrictions updated for "${name}"!`));
      if (newAllowedIps.length > 0) {
        const scopeText = newAdminOnlyRestriction ? "admin UI only (/_/)" : "entire instance";
        console.log(chalk.green(`Restriction scope: ${scopeText}`));
        console.log(chalk.green(`Allowed IPs: ${newAllowedIps.join(", ")}`));
      } else {
        console.log(chalk.green("All IP restrictions removed. Instance is now open to all IPs."));
      }
    } catch (error) {
      console.error(chalk.red(`Error updating IP restrictions: ${error.message}`));
    }
  });

program
  .command("renew-certificates [instanceName]")
  .description("Renew SSL certificates using Certbot. Renews all due certs, or a specific instance's cert.")
  .option("-f, --force", "Force renewal even if the certificate is not yet due for expiry.")
  .action(async (instanceName, options) => {
    if (!shell.which("certbot")) {
      console.error(chalk.red("Certbot command not found. Please install Certbot first."));
      return;
    }

    const targetInstanceName = instanceName && instanceName.toLowerCase() !== "all" ? instanceName : "all";
    let domainForPrompt = targetInstanceName;
    if (targetInstanceName !== "all") {
      const config = await getInstancesConfig();
      const instance = config.instances[targetInstanceName];
      if (!instance || !instance.useHttps) {
        console.error(chalk.red(`Instance "${targetInstanceName}" not found or does not use HTTPS.`));
        return;
      }
      domainForPrompt = instance.domain;
    }

    const certbotArgs = ["renew"];
    if (targetInstanceName !== "all") certbotArgs.push("--cert-name", domainForPrompt);
    if (options.force) certbotArgs.push("--force-renewal");

    const { confirmRenew } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmRenew",
        message: `This will run Certbot to renew certificates. Command: sudo certbot ${certbotArgs.join(" ")}. Proceed?`,
        default: true,
      },
    ]);
    if (!confirmRenew) {
      console.log(chalk.yellow("Certificate renewal cancelled by user."));
      return;
    }

    const renewPayload = {
      instanceName: targetInstanceName === "all" ? null : targetInstanceName,
      force: options.force || false,
    };
    const result = await _internalRenewCertificates(renewPayload);

    for (const msg of result.messages) {
      console.log(result.success ? chalk.green(msg) : chalk.red(msg));
    }
    if (!result.success) {
      console.error(chalk.red(`Certificate renewal failed: ${result.error || "Unknown error."}`));
    }
  });

program
  .command("update-pb-manager")
  .description("Update pb-manager itself from the latest version on GitHub")
  .action(async () => {
    const SCRIPT_URL = `${PB_MANAGER_UPDATE_SCRIPT_URL_BASE}${PB_MANAGER_SCRIPT_NAME}`;
    const CHECKSUM_URL = `${SCRIPT_URL}.sha256`;
    let installPath = process.argv[1];
    if (!installPath || !installPath.endsWith(PB_MANAGER_SCRIPT_NAME)) {
      installPath = DEFAULT_INSTALL_PATH_PB_MANAGER;
    }
    console.log(chalk.cyan(`Attempting to update pb-manager from ${SCRIPT_URL}`));
    const { confirmUpdateSelf } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmUpdateSelf",
        message: `This will download the latest version of pb-manager from GitHub and overwrite the current script at ${installPath}. Are you sure you want to proceed?`,
        default: true,
      },
    ]);
    if (!confirmUpdateSelf) {
      console.log(chalk.yellow("pb-manager update cancelled by user."));
      return;
    }

    try {
      const downloadSession = createSession({
        timeout: 60000,
        headers: { "User-Agent": "pb-manager" },
        maxRedirects: 5,
        httpVersion: "1.1",
        retry: { count: 3, delay: 1000, backoff: "exponential", jitter: 200 },
      });

      let scriptResponse, checksumResponse;
      try {
        [scriptResponse, checksumResponse] = await Promise.all([downloadSession.get(SCRIPT_URL), downloadSession.get(CHECKSUM_URL).catch(() => null)]);
      } finally {
        downloadSession.close();
      }

      if (!scriptResponse.ok) {
        console.error(chalk.red(`Failed to download pb-manager.js: server returned HTTP ${scriptResponse.status} ${scriptResponse.statusText}`));
        process.exit(1);
        return;
      }

      const newScriptContent = scriptResponse.text();

      if (checksumResponse?.ok && checksumResponse.text()) {
        const expectedChecksum = checksumResponse.text().trim().split(" ")[0];
        const downloadedChecksum = crypto.createHash("sha256").update(newScriptContent).digest("hex");
        if (downloadedChecksum !== expectedChecksum) {
          console.error(chalk.red("Checksum mismatch! Update aborted. The downloaded file may be compromised or outdated."));
          console.log(chalk.yellow(`Expected: ${expectedChecksum}, Got: ${downloadedChecksum}`));
          return;
        }
        if (completeLogging) console.log(chalk.green("Checksum verified."));
      } else {
        console.log(chalk.yellow("Could not fetch checksum. Proceeding without verification."));
      }

      const tempInstallPath = `${installPath}.${Date.now()}.tmp`;
      await fs.writeFile(tempInstallPath, newScriptContent, { mode: 0o755 });
      await safeRunCommand("sudo", ["mv", tempInstallPath, installPath], `Failed to move updated script to ${installPath}`);
      console.log(chalk.green(`pb-manager.js updated at ${installPath}`));
    } catch (e) {
      const detail = e instanceof Error ? `${e.constructor.name}: ${e.message || "(no message)"}` : String(e);
      console.error(chalk.red(`Failed to download or write pb-manager.js: ${detail}`));
      if (completeLogging && e instanceof Error && e.stack) console.error(e.stack);
      process.exit(1);
    }

    const { reinstall } = await inquirer.prompt([
      {
        type: "confirm",
        name: "reinstall",
        message: "Do you want to reinstall Node.js dependencies (npm install) in the install directory? This is recommended if the update included dependency changes.",
        default: true,
      },
    ]);
    if (reinstall) {
      try {
        const installDir = path.dirname(installPath);
        if (completeLogging) console.log(chalk.cyan("Running npm install..."));
        await safeRunCommand("npm", ["install"], "Failed to install dependencies", false, { cwd: installDir });
        if (completeLogging) console.log(chalk.green("Dependencies installed."));
      } catch (e) {
        console.error(chalk.red("Failed to install dependencies:"), e.message);
      }
    }
    console.log(chalk.bold.green("pb-manager has been updated. Please re-run your command if needed."));
    process.exit(0);
  });

program.helpInformation = () => `
  PocketBase Manager (pb-manager)
  A CLI tool to manage multiple PocketBase instances with Nginx, PM2, and Certbot.

  Version: ${pbManagerVersion}

  Usage:
    sudo pb-manager <command> [options]

  Main Commands:
    add | create                       Register a new PocketBase instance
    list [--json]                      List all managed PocketBase instances
    remove <name>                      Remove a PocketBase instance (prompts for data deletion)
    reset <name>                       Reset a PocketBase instance (delete all data, re-confirm needed)
    reset-admin <name>                 Reset the admin password for a PocketBase instance

  Instance Management:
    start <name | all>                 Start a specific PocketBase instance via PM2
    stop <name | all>                  Stop a specific PocketBase instance via PM2
    restart <name | all>               Restart a specific PocketBase instance or all instances via PM2
    logs <name>                        Show logs for a specific PocketBase instance from PM2
    update-ip-restrictions <name>      Update IP restrictions for an existing instance

  Setup & Configuration:
    setup [--version]                  Initial setup: creates directories and downloads PocketBase
    configure                          Set or view CLI configurations (default Certbot email, logging)

  Updates & Maintenance:
    renew-certificates <name | all>    Renew SSL certificates using Certbot (use --force to force renewal)
    update-pocketbase                  Update the PocketBase executable and restart all instances
    update-ecosystem                   Regenerate the PM2 ecosystem file and reload PM2
    update-pb-manager                  Update the pb-manager CLI from GitHub

  Other:
    help [command]                     Show help for a specific command

  Run all commands as root or with sudo.
`;

async function main() {
  if (process.geteuid && process.geteuid() !== 0) {
    console.error(chalk.red("You must run this script as root or with sudo. This is required for managing system services and configurations."));
    process.exit(1);
  }

  const [, cliConfig] = await Promise.all([detectDistro(), getCliConfig()]);
  completeLogging = cliConfig.completeLogging || false;

  const command = process.argv[2];
  const skipVersionCheck = !command || ["setup", "configure", "update-pb-manager"].includes(command);

  if (!skipVersionCheck) {
    const versionCheckPromise = (async () => {
      const installedVersion = await getInstalledPocketBaseVersion();
      if (installedVersion) {
        const latestVersion = await getCachedLatestVersion();
        if (latestVersion && installedVersion !== latestVersion) {
          console.log(chalk.yellow(`A new version of PocketBase (v${latestVersion}) is available. You are currently on v${installedVersion}.`));
          console.log(chalk.yellow("Consider running 'pb-manager update-pocketbase' to update."));
        }
      }
    })();

    if (!shell.which("pm2")) {
      console.error(chalk.red("PM2 is not installed or not in PATH. PM2 is essential for managing PocketBase instances."));
      console.log(chalk.blue("Please install PM2 globally by running: npm install -g pm2"));
      console.log(chalk.blue("Then, set it up to start on boot: sudo pm2 startup (and follow instructions)"));
      process.exit(1);
    }
    if (!shell.which("nginx")) {
      console.warn(chalk.yellow("Nginx is not found in PATH. Nginx is required for reverse proxying and HTTPS."));
      console.log(chalk.blue("Please install Nginx (e.g., sudo apt install nginx or sudo dnf install nginx)."));
    }

    await versionCheckPromise;
  }

  await ensureBaseSetup();
  await program.parseAsync(process.argv);
}

main().catch(async (err) => {
  console.error(chalk.red("An unexpected error occurred:"), err.message);
  const cliConfig = await getCliConfig().catch(() => ({ completeLogging: false }));
  if (err.stack && (cliConfig.completeLogging || process.env.DEBUG)) {
    console.error(err.stack);
  }
  process.exit(1);
});
