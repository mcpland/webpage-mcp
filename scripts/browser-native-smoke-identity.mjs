#!/usr/bin/env node

import console from "node:console";
import { generateKeyPairSync } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { deriveChromeExtensionId } from "./extension-public-key.mjs";

export function createBrowserNativeSmokeIdentity() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const encodedPublicKey = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  return {
    extensionId: deriveChromeExtensionId(encodedPublicKey),
    encodedPublicKey,
  };
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  console.log(JSON.stringify(createBrowserNativeSmokeIdentity()));
}
