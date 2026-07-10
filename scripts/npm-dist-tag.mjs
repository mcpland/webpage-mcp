import console from "node:console";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function resolveNpmDistTag(version) {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${String(version)}`);
  const prerelease = match[4];
  if (!prerelease) return "latest";

  const channel = prerelease.split(".")[0].toLowerCase();
  if (/^\d+$/.test(channel) || channel === "latest") return "next";
  return channel;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    console.log(resolveNpmDistTag(process.argv[2]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
