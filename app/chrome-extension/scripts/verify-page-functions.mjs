#!/usr/bin/env node

// Functions that the extension serializes with Function.prototype.toString()
// and evaluates inside a page (for example the chrome_javascript result
// serializer sent through Runtime.callFunctionOn, and chrome.scripting
// executeScript({ func }) callbacks) must not depend on any binding of the
// extension bundle. Unit tests run those functions from source, so only the
// built artifact can prove that bundling/minification kept them self-contained.
// This script statically checks free identifiers across page-injected functions
// and executes the serializer in an empty VM context.

import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parse } from "acorn";

const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultBundleDir = resolve(scriptDir, "../.output/chrome-mv3");

const SERIALIZER_MARKER = "JavaScript result holder could not be read";

const ECMASCRIPT_GLOBALS = new Set([
  ...Object.getOwnPropertyNames(vm.runInNewContext("this")),
  "globalThis",
  "undefined",
  "NaN",
  "Infinity",
]);

const BROWSER_PAGE_GLOBALS = new Set([
  ...ECMASCRIPT_GLOBALS,
  "window",
  "self",
  "document",
  "location",
  "history",
  "navigator",
  "screen",
  "performance",
  "console",
  "chrome",
  "CSS",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "SVGElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLOptionElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "HTMLFormElement",
  "HTMLIFrameElement",
  "HTMLImageElement",
  "HTMLMediaElement",
  "HTMLVideoElement",
  "HTMLAudioElement",
  "HTMLCanvasElement",
  "HTMLScriptElement",
  "HTMLStyleElement",
  "Document",
  "DocumentFragment",
  "ShadowRoot",
  "Text",
  "Comment",
  "Attr",
  "DOMRect",
  "DOMException",
  "Range",
  "Selection",
  "TreeWalker",
  "NodeList",
  "HTMLCollection",
  "Event",
  "CustomEvent",
  "UIEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "InputEvent",
  "FocusEvent",
  "WheelEvent",
  "TouchEvent",
  "ClipboardEvent",
  "DragEvent",
  "DataTransfer",
  "EventTarget",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "XPathResult",
  "XPathEvaluator",
  "DOMParser",
  "XMLSerializer",
  "URL",
  "URLSearchParams",
  "Headers",
  "Request",
  "Response",
  "FormData",
  "Blob",
  "File",
  "FileReader",
  "AbortController",
  "AbortSignal",
  "TextEncoder",
  "TextDecoder",
  "CustomElementRegistry",
  "crypto",
  "fetch",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "queueMicrotask",
  "structuredClone",
  "getComputedStyle",
  "getSelection",
  "matchMedia",
  "atob",
  "btoa",
  "localStorage",
  "sessionStorage",
  "devicePixelRatio",
  "innerWidth",
  "innerHeight",
  "outerWidth",
  "outerHeight",
  "scrollX",
  "scrollY",
  "pageXOffset",
  "pageYOffset",
  "scrollTo",
  "scrollBy",
  "alert",
  "confirm",
  "prompt",
]);

// Each case runs the bundled serializer against a holder constructed inside
// the target VM realm, matching the shape produced by chrome_javascript.
const SERIALIZER_CASES = [
  {
    name: "number result",
    holder: (context) =>
      vm.runInContext("({ __webpageMcpStatus: 1, __webpageMcpValue: 2 })", context),
    expect: (envelope) => envelope.status === "success" && envelope.text === "2",
  },
  {
    name: "object result",
    holder: (context) =>
      vm.runInContext(
        '({ __webpageMcpStatus: 1, __webpageMcpValue: { title: "Form", ids: ["a", "b"] } })',
        context,
      ),
    expect: (envelope) =>
      envelope.status === "success" &&
      envelope.text.includes('"title"') &&
      envelope.text.includes('"Form"'),
  },
  {
    name: "bigint result",
    holder: (context) =>
      vm.runInContext("({ __webpageMcpStatus: 1, __webpageMcpValue: 12n })", context),
    expect: (envelope) => envelope.status === "success",
  },
  {
    name: "thrown error",
    holder: (context) =>
      vm.runInContext(
        '({ __webpageMcpStatus: 0, __webpageMcpValue: new Error("boom") })',
        context,
      ),
    expect: (envelope) =>
      envelope.status === "error" &&
      envelope.errorKind === "runtime_error" &&
      envelope.message.includes("boom"),
  },
];

function fail(message) {
  throw new Error(`[page-functions] ${message}`);
}

function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== "string") return;
  visit(node, ancestors);
  ancestors.push(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    if (Array.isArray(child)) {
      for (const entry of child) walk(entry, visit, ancestors);
    } else if (child && typeof child.type === "string") {
      walk(child, visit, ancestors);
    }
  }
  ancestors.pop();
}

function collectPatternBindings(pattern, target) {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      target.add(pattern.name);
      return;
    case "RestElement":
      collectPatternBindings(pattern.argument, target);
      return;
    case "AssignmentPattern":
      collectPatternBindings(pattern.left, target);
      return;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        collectPatternBindings(element, target);
      }
      return;
    case "ObjectPattern":
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") {
          collectPatternBindings(prop.argument, target);
        } else {
          collectPatternBindings(prop.value, target);
        }
      }
      return;
    default:
      return;
  }
}

function collectHoistedVarBindings(node, target) {
  if (!node || typeof node.type !== "string") return;
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return;
  }
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const decl of node.declarations) {
      collectPatternBindings(decl.id, target);
    }
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    if (Array.isArray(child)) {
      for (const entry of child) collectHoistedVarBindings(entry, target);
    } else if (child && typeof child.type === "string") {
      collectHoistedVarBindings(child, target);
    }
  }
}

function collectDirectBlockBindings(statements, target) {
  if (!Array.isArray(statements)) return;
  for (const stmt of statements) {
    if (!stmt) continue;
    if (
      stmt.type === "VariableDeclaration" &&
      (stmt.kind === "let" || stmt.kind === "const")
    ) {
      for (const decl of stmt.declarations) {
        collectPatternBindings(decl.id, target);
      }
    } else if (
      (stmt.type === "FunctionDeclaration" || stmt.type === "ClassDeclaration") &&
      stmt.id?.name
    ) {
      target.add(stmt.id.name);
    }
  }
}

/**
 * Computes free identifier references inside a function AST node (including
 * branches that runtime test cases may not execute).
 */
export function findFreeIdentifiers(fnNode) {
  const free = new Set();
  const scopes = [];

  const isBound = (name) => {
    for (let i = scopes.length - 1; i >= 0; i -= 1) {
      if (scopes[i].has(name)) return true;
    }
    return false;
  };

  const visitBindingPatternExpressions = (pattern) => {
    if (!pattern) return;
    switch (pattern.type) {
      case "Identifier":
        return;
      case "RestElement":
        visitBindingPatternExpressions(pattern.argument);
        return;
      case "AssignmentPattern":
        visitBindingPatternExpressions(pattern.left);
        visitNode(pattern.right);
        return;
      case "ArrayPattern":
        for (const element of pattern.elements) {
          visitBindingPatternExpressions(element);
        }
        return;
      case "ObjectPattern":
        for (const prop of pattern.properties) {
          if (prop.type === "RestElement") {
            visitBindingPatternExpressions(prop.argument);
          } else {
            if (prop.computed) visitNode(prop.key);
            visitBindingPatternExpressions(prop.value);
          }
        }
        return;
      default:
        return;
    }
  };

  const visitFunction = (node, bindOwnId) => {
    const scope = new Set();
    if (bindOwnId && node.id?.name) {
      scope.add(node.id.name);
    }
    if (node.type !== "ArrowFunctionExpression") {
      scope.add("arguments");
    }
    for (const param of node.params) {
      collectPatternBindings(param, scope);
    }
    collectHoistedVarBindings(node.body, scope);
    scopes.push(scope);
    for (const param of node.params) {
      visitBindingPatternExpressions(param);
    }
    visitNode(node.body);
    scopes.pop();
  };

  const visitNode = (node) => {
    if (!node || typeof node.type !== "string") return;
    switch (node.type) {
      case "Identifier":
        if (!isBound(node.name)) free.add(node.name);
        return;
      case "FunctionDeclaration":
        visitFunction(node, true);
        return;
      case "FunctionExpression":
        visitFunction(node, true);
        return;
      case "ArrowFunctionExpression":
        visitFunction(node, false);
        return;
      case "BlockStatement":
      case "StaticBlock": {
        const scope = new Set();
        collectDirectBlockBindings(node.body, scope);
        scopes.push(scope);
        for (const stmt of node.body) visitNode(stmt);
        scopes.pop();
        return;
      }
      case "SwitchStatement": {
        visitNode(node.discriminant);
        const scope = new Set();
        for (const switchCase of node.cases) {
          collectDirectBlockBindings(switchCase.consequent, scope);
        }
        scopes.push(scope);
        for (const switchCase of node.cases) {
          visitNode(switchCase.test);
          for (const stmt of switchCase.consequent) visitNode(stmt);
        }
        scopes.pop();
        return;
      }
      case "ForStatement": {
        const scope = new Set();
        if (
          node.init?.type === "VariableDeclaration" &&
          node.init.kind !== "var"
        ) {
          for (const decl of node.init.declarations) {
            collectPatternBindings(decl.id, scope);
          }
        }
        scopes.push(scope);
        visitNode(node.init);
        visitNode(node.test);
        visitNode(node.update);
        visitNode(node.body);
        scopes.pop();
        return;
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const scope = new Set();
        if (
          node.left?.type === "VariableDeclaration" &&
          node.left.kind !== "var"
        ) {
          for (const decl of node.left.declarations) {
            collectPatternBindings(decl.id, scope);
          }
        }
        scopes.push(scope);
        visitNode(node.left);
        visitNode(node.right);
        visitNode(node.body);
        scopes.pop();
        return;
      }
      case "CatchClause": {
        const scope = new Set();
        collectPatternBindings(node.param, scope);
        scopes.push(scope);
        visitBindingPatternExpressions(node.param);
        visitNode(node.body);
        scopes.pop();
        return;
      }
      case "VariableDeclaration":
        for (const decl of node.declarations) {
          visitBindingPatternExpressions(decl.id);
          visitNode(decl.init);
        }
        return;
      case "ClassDeclaration":
      case "ClassExpression": {
        visitNode(node.superClass);
        const scope = new Set();
        if (node.type === "ClassExpression" && node.id?.name) {
          scope.add(node.id.name);
        }
        scopes.push(scope);
        visitNode(node.body);
        scopes.pop();
        return;
      }
      case "MemberExpression":
        visitNode(node.object);
        if (node.computed) visitNode(node.property);
        return;
      case "Property":
        if (node.computed) visitNode(node.key);
        visitNode(node.value);
        return;
      case "MethodDefinition":
      case "PropertyDefinition":
        if (node.computed) visitNode(node.key);
        visitNode(node.value);
        return;
      case "LabeledStatement":
        visitNode(node.body);
        return;
      case "BreakStatement":
      case "ContinueStatement":
      case "MetaProperty":
      case "PrivateIdentifier":
      case "ThisExpression":
      case "Super":
      case "Literal":
        return;
      default:
        for (const [key, child] of Object.entries(node)) {
          if (key === "start" || key === "end" || key === "loc") continue;
          if (Array.isArray(child)) {
            for (const entry of child) visitNode(entry);
          } else if (child && typeof child.type === "string") {
            visitNode(child);
          }
        }
        return;
    }
  };

  visitFunction(fnNode, true);
  return [...free].sort();
}

function parseModule(source) {
  return parse(source, {
    allowHashBang: true,
    ecmaVersion: "latest",
    sourceType: "module",
  });
}

function findFunctionContainingNode(ast, marker) {
  const matches = [];
  walk(ast, (node, ancestors) => {
    if (node.type !== "Literal" || node.value !== marker) return;
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
      const candidate = ancestors[index];
      if (
        candidate.type === "FunctionDeclaration" ||
        candidate.type === "FunctionExpression"
      ) {
        matches.push(candidate);
        return;
      }
    }
  });
  const unique = [...new Set(matches)];
  if (unique.length === 0) return null;
  if (unique.length > 1) {
    fail(`marker "${marker}" appears in ${unique.length} different functions`);
  }
  return unique[0];
}

/**
 * Returns the source of the innermost non-arrow function that contains the
 * string literal `marker`.
 */
export function extractFunctionContaining(source, marker) {
  const ast = parseModule(source);
  const match = findFunctionContainingNode(ast, marker);
  return match ? source.slice(match.start, match.end) : null;
}

function isExecuteScriptCallee(callee) {
  const target = callee?.type === "ChainExpression" ? callee.expression : callee;
  if (!target || target.type !== "MemberExpression") return false;
  const methodName =
    !target.computed && target.property?.type === "Identifier"
      ? target.property.name
      : target.computed && target.property?.type === "Literal"
        ? target.property.value
        : null;
  if (methodName !== "executeScript") return false;
  const receiver =
    target.object?.type === "ChainExpression"
      ? target.object.expression
      : target.object;
  if (!receiver || receiver.type !== "MemberExpression") return false;
  const namespaceName =
    !receiver.computed && receiver.property?.type === "Identifier"
      ? receiver.property.name
      : receiver.computed && receiver.property?.type === "Literal"
        ? receiver.property.value
        : null;
  return namespaceName === "scripting";
}

function extractExecuteScriptFunctions(ast) {
  const namedFunctions = new Map();
  walk(ast, (node) => {
    if (node.type === "FunctionDeclaration" && node.id?.name) {
      if (!namedFunctions.has(node.id.name)) {
        namedFunctions.set(node.id.name, node);
      }
    } else if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      (node.init?.type === "FunctionExpression" ||
        node.init?.type === "ArrowFunctionExpression")
    ) {
      if (!namedFunctions.has(node.id.name)) {
        namedFunctions.set(node.id.name, node.init);
      }
    }
  });

  const functions = [];
  walk(ast, (node) => {
    if (node.type !== "CallExpression" || !isExecuteScriptCallee(node.callee)) {
      return;
    }
    const firstArg = node.arguments?.[0];
    if (!firstArg || firstArg.type !== "ObjectExpression") return;
    const funcProp = firstArg.properties.find((prop) => {
      if (prop.type !== "Property") return false;
      if (!prop.computed && prop.key?.type === "Identifier") {
        return prop.key.name === "func";
      }
      if (prop.key?.type === "Literal") return prop.key.value === "func";
      return false;
    });
    if (!funcProp) return;
    if (
      funcProp.value?.type === "FunctionExpression" ||
      funcProp.value?.type === "ArrowFunctionExpression"
    ) {
      functions.push({
        label: `executeScript(func)@${funcProp.value.start}`,
        node: funcProp.value,
      });
    } else if (funcProp.value?.type === "Identifier") {
      const resolved = namedFunctions.get(funcProp.value.name);
      if (resolved) {
        functions.push({
          label: `executeScript(func:${funcProp.value.name})@${funcProp.value.start}`,
          node: resolved,
        });
      }
    }
  });
  return functions;
}

export function verifySerializerSource(functionSource) {
  const failures = [];
  let fnNode;
  try {
    const parsed = parse(`(${functionSource})`, {
      ecmaVersion: "latest",
      sourceType: "script",
    });
    fnNode = parsed.body?.[0]?.expression;
  } catch (error) {
    failures.push(
      `parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (fnNode) {
    const disallowed = findFreeIdentifiers(fnNode).filter(
      (name) => !ECMASCRIPT_GLOBALS.has(name),
    );
    if (disallowed.length > 0) {
      failures.push(
        `static free-variable check found non-global binding(s): ${disallowed.join(", ")}`,
      );
    }
  }
  for (const testCase of SERIALIZER_CASES) {
    // A fresh context has only ECMAScript built-ins: any reference to a
    // bundle-scope helper surfaces as a ReferenceError inside the serializer.
    const context = vm.createContext(Object.create(null));
    let envelope;
    try {
      const serializer = vm.runInContext(`(${functionSource})`, context);
      envelope = serializer.call(testCase.holder(context), 4096);
    } catch (error) {
      failures.push(
        `${testCase.name}: threw ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!envelope || envelope.version !== 1 || !testCase.expect(envelope)) {
      failures.push(`${testCase.name}: unexpected envelope ${JSON.stringify(envelope)}`);
    }
  }
  return failures;
}

export async function verifyPageFunctions(options = {}) {
  const bundleDir = resolve(options.bundleDir ?? defaultBundleDir);
  const backgroundPath = join(bundleDir, "background.js");
  const stats = await lstat(backgroundPath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    fail("background.js must be a regular file");
  }
  if (stats.size > MAX_BUNDLE_BYTES) fail("background.js is too large");
  const source = await readFile(backgroundPath, "utf8");
  const ast = parseModule(source);
  const serializerNode = findFunctionContainingNode(ast, SERIALIZER_MARKER);
  if (!serializerNode) {
    fail("chrome_javascript page serializer was not found in background.js");
  }
  const serializer = source.slice(serializerNode.start, serializerNode.end);
  const failures = verifySerializerSource(serializer);
  if (failures.length > 0) {
    fail(
      `chrome_javascript page serializer is not self-contained after bundling:\n  ${failures.join("\n  ")}`,
    );
  }

  const executeScriptFns = extractExecuteScriptFunctions(ast);
  const executeScriptFailures = [];
  for (const entry of executeScriptFns) {
    const disallowed = findFreeIdentifiers(entry.node).filter(
      (name) => !BROWSER_PAGE_GLOBALS.has(name),
    );
    if (disallowed.length > 0) {
      executeScriptFailures.push(
        `${entry.label}: non-global binding(s) ${disallowed.join(", ")}`,
      );
    }
  }
  if (executeScriptFailures.length > 0) {
    fail(
      `chrome.scripting.executeScript func is not self-contained after bundling:\n  ${executeScriptFailures.join("\n  ")}`,
    );
  }

  return {
    functions: 1 + executeScriptFns.length,
    cases: SERIALIZER_CASES.length,
  };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  verifyPageFunctions({ bundleDir: process.argv[2] })
    .then(({ functions, cases }) => {
      console.log(
        `[page-functions] verified ${functions} page-serialized function(s) (${cases} runtime cases)`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
