import { Buffer } from "node:buffer";

import { parse } from "acorn";

const MAX_MCP_EXECUTABLE_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_JAVASCRIPT_AST_NODES = 2_000_000;

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseExecutableJavaScript(source) {
  const options = {
    allowHashBang: true,
    ecmaVersion: "latest",
  };
  try {
    return parse(source, { ...options, sourceType: "script" });
  } catch {
    try {
      return parse(source, { ...options, sourceType: "module" });
    } catch {
      throw new Error("packed JavaScript cannot be parsed safely");
    }
  }
}

function staticModuleSpecifier(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  return undefined;
}

function bundledDependencyForSpecifier(specifier, bundleNames) {
  if (typeof specifier !== "string") return undefined;
  return bundleNames.find(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

export function findExternalBundledDependency(source, bundleNames) {
  invariant(typeof source === "string", "packed JavaScript must be text");
  invariant(
    Buffer.byteLength(source, "utf8") <= MAX_MCP_EXECUTABLE_SOURCE_BYTES,
    "packed JavaScript exceeds the executable source limit",
  );
  const reviewedNames = [...bundleNames];
  const stack = [parseExecutableJavaScript(source)];
  const seen = new WeakSet();
  let visitedNodes = 0;

  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node) || typeof node.type !== "string" || seen.has(node)) {
      continue;
    }
    seen.add(node);
    visitedNodes += 1;
    invariant(
      visitedNodes <= MAX_JAVASCRIPT_AST_NODES,
      "packed JavaScript exceeds the syntax-node limit",
    );

    let specifier;
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require" &&
      node.arguments.length === 1
    ) {
      specifier = staticModuleSpecifier(node.arguments[0]);
    } else if (node.type === "ImportExpression") {
      specifier = staticModuleSpecifier(node.source);
    } else if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      specifier = staticModuleSpecifier(node.source);
    }

    const dependency = bundledDependencyForSpecifier(specifier, reviewedNames);
    if (dependency !== undefined) return dependency;

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isRecord(child) && typeof child.type === "string") {
            stack.push(child);
          }
        }
      } else if (isRecord(value) && typeof value.type === "string") {
        stack.push(value);
      }
    }
  }
  return undefined;
}
