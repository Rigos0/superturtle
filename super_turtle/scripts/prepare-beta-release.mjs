import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.resolve(__dirname, "..", "package.json");

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported package version '${version}'.`);
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] || "",
  };
}

function parsePositiveInt(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue ?? ""), 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
const currentVersion = String(packageJson.version || "").trim();
const parsedVersion = parseSemver(currentVersion);
const baseVersion = parsedVersion.prerelease
  ? `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}`
  : `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch + 1}`;

const runNumber = parsePositiveInt(process.env.GITHUB_RUN_NUMBER, Math.floor(Date.now() / 1000));
const runAttempt = parsePositiveInt(process.env.GITHUB_RUN_ATTEMPT, 1);
const shortSha = String(process.env.GITHUB_SHA || "local").trim().slice(0, 7) || "local";
const packageVersion = `${baseVersion}-beta.${runNumber}.${runAttempt}`;

packageJson.version = packageVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf-8");

process.stdout.write(`package_version=${packageVersion}\n`);
process.stdout.write(`runtime_install_spec=superturtle@${packageVersion}\n`);
process.stdout.write(`template_version_tag=v${packageVersion}\n`);
process.stdout.write(`template_channel=managed-codex\n`);
process.stdout.write(`sha_tag=sha-${shortSha}\n`);
