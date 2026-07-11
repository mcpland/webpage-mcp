// expression.ts — minimal safe boolean expression evaluator (no access to global scope)
// Supported:
// - Literals: numbers (123, 1.23), strings ('x' or "x"), booleans (true/false)
// - Variables: vars.x, workflow.x (only reads own properties from provided vars object)
// - Operators: !, &&, ||, ==, !=, ===, !==, >, >=, <, <=, +, -, *, /
// - Parentheses: ( ... )

type Token = { type: string; value?: any };

export const EXPRESSION_LIMITS = Object.freeze({
  maxChars: 4_096,
  maxTokens: 512,
  maxNesting: 64,
  maxPathSegments: 32,
});

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function tokenize(input: string): Token[] {
  if (typeof input !== "string" || input.length > EXPRESSION_LIMITS.maxChars) {
    throw new Error("Expression exceeds the supported length");
  }
  const s = input.trim();
  const out: Token[] = [];
  let i = 0;
  const isAlpha = (c: string) => /[a-zA-Z_]/.test(c);
  const isNum = (c: string) => /[0-9]/.test(c);
  const isIdChar = (c: string) => /[a-zA-Z0-9_]/.test(c);
  const push = (token: Token): void => {
    if (out.length >= EXPRESSION_LIMITS.maxTokens) {
      throw new Error("Expression exceeds the supported token count");
    }
    out.push(token);
  };
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // operators
    if (s.startsWith("===", i) || s.startsWith("!==", i)) {
      push({ type: "op", value: s.slice(i, i + 3) });
      i += 3;
      continue;
    }
    if (
      s.startsWith("&&", i) ||
      s.startsWith("||", i) ||
      s.startsWith("==", i) ||
      s.startsWith("!=", i) ||
      s.startsWith(">=", i) ||
      s.startsWith("<=", i)
    ) {
      push({ type: "op", value: s.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if ("!+-*/()<>".includes(c)) {
      push({ type: "op", value: c });
      i++;
      continue;
    }
    // number
    if (isNum(c) || (c === "." && isNum(s[i + 1] || ""))) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(
        s.slice(i),
      );
      if (!match) throw new Error("Invalid number literal");
      const value = Number(match[0]);
      if (!Number.isFinite(value))
        throw new Error("Number literal is not finite");
      push({ type: "num", value });
      i += match[0].length;
      continue;
    }
    // string
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let str = "";
      let closed = false;
      while (j < s.length) {
        if (s[j] === "\\" && j + 1 < s.length) {
          str += s[j + 1];
          j += 2;
        } else if (s[j] === quote) {
          j++;
          closed = true;
          break;
        } else {
          str += s[j++];
        }
      }
      if (!closed) throw new Error("Unterminated string literal");
      push({ type: "str", value: str });
      i = j;
      continue;
    }
    // identifier (vars or true/false)
    if (isAlpha(c)) {
      let j = i + 1;
      while (j < s.length && isIdChar(s[j])) j++;
      let id = s.slice(i, j);
      // dotted path
      while (s[j] === "." && isAlpha(s[j + 1] || "")) {
        let k = j + 1;
        while (k < s.length && isIdChar(s[k])) k++;
        id += s.slice(j, k);
        j = k;
      }
      if (id.split(".").length > EXPRESSION_LIMITS.maxPathSegments + 1) {
        throw new Error("Expression path is too deep");
      }
      push({ type: "id", value: id });
      i = j;
      continue;
    }
    throw new Error(`Unsupported expression token at offset ${i}`);
  }
  return out;
}

// Recursive descent parser
function evaluateExpression(
  expr: string,
  scope: { vars: Record<string, any> },
  throwOnError: boolean,
): any {
  try {
    const tokens = tokenize(expr);
    let i = 0;
    let nesting = 0;
    const peek = () => tokens[i];
    const consume = () => tokens[i++];

    const enterNesting = (): void => {
      nesting += 1;
      if (nesting > EXPRESSION_LIMITS.maxNesting) {
        throw new Error("Expression nesting is too deep");
      }
    };

    const leaveNesting = (): void => {
      nesting -= 1;
    };

    function parsePrimary(): any {
      const t = peek();
      if (!t) throw new Error("Expected expression value");
      if (t.type === "num") {
        consume();
        return t.value;
      }
      if (t.type === "str") {
        consume();
        return t.value;
      }
      if (t.type === "id") {
        consume();
        const id = String(t.value);
        if (id === "true") return true;
        if (id === "false") return false;
        if (id === "null") return null;
        const [root, ...parts] = id.split(".");
        if (root !== "vars" && root !== "workflow") {
          throw new Error("Expression root is not allowed");
        }
        let cur: any = scope.vars;
        for (const part of parts) {
          if (UNSAFE_PATH_SEGMENTS.has(part)) {
            throw new Error("Expression path segment is not allowed");
          }
          if (
            cur == null ||
            typeof cur !== "object" ||
            !Object.prototype.hasOwnProperty.call(cur, part)
          ) {
            return undefined;
          }
          cur = cur[part];
        }
        return cur;
      }
      if (t.type === "op" && t.value === "(") {
        consume();
        enterNesting();
        try {
          const value = parseOr();
          if (peek()?.type !== "op" || peek()?.value !== ")") {
            throw new Error("Unclosed expression group");
          }
          consume();
          return value;
        } finally {
          leaveNesting();
        }
      }
      throw new Error("Expected expression value");
    }

    function parseUnary(): any {
      const t = peek();
      if (t && t.type === "op" && (t.value === "!" || t.value === "-")) {
        consume();
        enterNesting();
        try {
          const value = parseUnary();
          return t.value === "!" ? !truthy(value) : -Number(value || 0);
        } finally {
          leaveNesting();
        }
      }
      return parsePrimary();
    }

    function parseMulDiv(): any {
      let value = parseUnary();
      while (
        peek() &&
        peek().type === "op" &&
        (peek().value === "*" || peek().value === "/")
      ) {
        const op = consume().value;
        const right = parseUnary();
        value =
          op === "*"
            ? Number(value || 0) * Number(right || 0)
            : Number(value || 0) / Number(right || 0);
      }
      return value;
    }

    function parseAddSub(): any {
      let value = parseMulDiv();
      while (
        peek() &&
        peek().type === "op" &&
        (peek().value === "+" || peek().value === "-")
      ) {
        const op = consume().value;
        const right = parseMulDiv();
        value =
          op === "+"
            ? Number(value || 0) + Number(right || 0)
            : Number(value || 0) - Number(right || 0);
      }
      return value;
    }

    function parseRel(): any {
      let value = parseAddSub();
      while (
        peek() &&
        peek().type === "op" &&
        [">", ">=", "<", "<="].includes(peek().value)
      ) {
        const op = consume().value as string;
        const right = parseAddSub();
        const leftComparable = toComparable(value);
        const rightComparable = toComparable(right);
        if (op === ">")
          value = (leftComparable as any) > (rightComparable as any);
        else if (op === ">=")
          value = (leftComparable as any) >= (rightComparable as any);
        else if (op === "<")
          value = (leftComparable as any) < (rightComparable as any);
        else value = (leftComparable as any) <= (rightComparable as any);
      }
      return value;
    }

    function parseEq(): any {
      let value = parseRel();
      while (
        peek() &&
        peek().type === "op" &&
        ["==", "!=", "===", "!=="].includes(peek().value)
      ) {
        const op = consume().value as string;
        const right = parseRel();
        const leftComparable = toComparable(value);
        const rightComparable = toComparable(right);
        value =
          op === "==" || op === "==="
            ? leftComparable === rightComparable
            : leftComparable !== rightComparable;
      }
      return value;
    }

    function parseAnd(): any {
      let value = parseEq();
      while (peek() && peek().type === "op" && peek().value === "&&") {
        consume();
        const right = parseEq();
        value = truthy(value) && truthy(right);
      }
      return value;
    }

    function parseOr(): any {
      let value = parseAnd();
      while (peek() && peek().type === "op" && peek().value === "||") {
        consume();
        const right = parseAnd();
        value = truthy(value) || truthy(right);
      }
      return value;
    }

    function truthy(value: any) {
      return !!value;
    }
    function toComparable(value: any) {
      return typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
        ? value
        : String(value);
    }

    const result = parseOr();
    if (i !== tokens.length)
      throw new Error("Expression contains trailing tokens");
    return result;
  } catch (error) {
    if (throwOnError) throw error;
    return false;
  }
}

export function evalExpression(
  expr: string,
  scope: { vars: Record<string, any> },
): any {
  return evaluateExpression(expr, scope, false);
}

export type ExpressionEvaluation =
  | { ok: true; value: any }
  | { ok: false; error: string };

export function tryEvalExpression(
  expr: string,
  scope: { vars: Record<string, any> },
): ExpressionEvaluation {
  try {
    return { ok: true, value: evaluateExpression(expr, scope, true) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid expression",
    };
  }
}
