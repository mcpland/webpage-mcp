// expression.ts — minimal safe boolean expression evaluator (no access to global scope)
// Supported:
// - Literals: numbers (123, 1.23), strings ('x' or "x"), booleans (true/false)
// - Variables: vars.x, vars.a.b (only reads from provided vars object)
// - Operators: !, &&, ||, ==, !=, >, >=, <, <=, +, -, *, /
// - Parentheses: ( ... )

type Token = { type: string; value?: any };

function tokenize(input: string): Token[] {
  const s = input.trim();
  const out: Token[] = [];
  let i = 0;
  const isAlpha = (c: string) => /[a-zA-Z_]/.test(c);
  const isNum = (c: string) => /[0-9]/.test(c);
  const isIdChar = (c: string) => /[a-zA-Z0-9_]/.test(c);
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    // operators
    if (
      s.startsWith('&&', i) ||
      s.startsWith('||', i) ||
      s.startsWith('==', i) ||
      s.startsWith('!=', i) ||
      s.startsWith('>=', i) ||
      s.startsWith('<=', i)
    ) {
      out.push({ type: 'op', value: s.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if ('!+-*/()<>'.includes(c)) {
      out.push({ type: 'op', value: c });
      i++;
      continue;
    }
    // number
    if (isNum(c) || (c === '.' && isNum(s[i + 1] || ''))) {
      let j = i + 1;
      while (j < s.length && (isNum(s[j]) || s[j] === '.')) j++;
      out.push({ type: 'num', value: parseFloat(s.slice(i, j)) });
      i = j;
      continue;
    }
    // string
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let str = '';
      while (j < s.length) {
        if (s[j] === '\\' && j + 1 < s.length) {
          str += s[j + 1];
          j += 2;
        } else if (s[j] === quote) {
          j++;
          break;
        } else {
          str += s[j++];
        }
      }
      out.push({ type: 'str', value: str });
      i = j;
      continue;
    }
    // identifier (vars or true/false)
    if (isAlpha(c)) {
      let j = i + 1;
      while (j < s.length && isIdChar(s[j])) j++;
      let id = s.slice(i, j);
      // dotted path
      while (s[j] === '.' && isAlpha(s[j + 1] || '')) {
        let k = j + 1;
        while (k < s.length && isIdChar(s[k])) k++;
        id += s.slice(j, k);
        j = k;
      }
      out.push({ type: 'id', value: id });
      i = j;
      continue;
    }
    // unknown token, skip to avoid crash
    i++;
  }
  return out;
}

// Recursive descent parser
export function evalExpression(expr: string, scope: { vars: Record<string, any> }): any {
  const tokens = tokenize(expr);
  let i = 0;
  const peek = () => tokens[i];
  const consume = () => tokens[i++];

  function parsePrimary(): any {
    const t = peek();
    if (!t) return undefined;
    if (t.type === 'num') {
      consume();
      return t.value;
    }
    if (t.type === 'str') {
      consume();
      return t.value;
    }
    if (t.type === 'id') {
      consume();
      const id = String(t.value);
      if (id === 'true') return true;
      if (id === 'false') return false;
      // Only allow vars.* lookups
      if (!id.startsWith('vars')) return undefined;
      try {
        const parts = id.split('.').slice(1);
        let cur: any = scope.vars;
        for (const p of parts) {
          if (cur == null) return undefined;
          cur = cur[p];
        }
        return cur;
      } catch {
        return undefined;
      }
    }
    if (t.type === 'op' && t.value === '(') {
      consume();
      const v = parseOr();
      if (peek()?.type === 'op' && peek()?.value === ')') consume();
      return v;
    }
    return undefined;
  }

  function parseUnary(): any {
    const t = peek();
    if (t && t.type === 'op' && (t.value === '!' || t.value === '-')) {
      consume();
      const v = parseUnary();
      return t.value === '!' ? !truthy(v) : -Number(v || 0);
    }
    return parsePrimary();
  }

  function parseMulDiv(): any {
    let v = parseUnary();
    while (peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/')) {
      const op = consume().value;
      const r = parseUnary();
      v = op === '*' ? Number(v || 0) * Number(r || 0) : Number(v || 0) / Number(r || 0);
    }
    return v;
  }

  function parseAddSub(): any {
    let v = parseMulDiv();
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const r = parseMulDiv();
      v = op === '+' ? Number(v || 0) + Number(r || 0) : Number(v || 0) - Number(r || 0);
    }
    return v;
  }

  function parseRel(): any {
    let v = parseAddSub();
    while (peek() && peek().type === 'op' && ['>', '>=', '<', '<='].includes(peek().value)) {
      const op = consume().value as string;
      const r = parseAddSub();
      const a = toComparable(v);
      const b = toComparable(r);
      if (op === '>') v = (a as any) > (b as any);
      else if (op === '>=') v = (a as any) >= (b as any);
      else if (op === '<') v = (a as any) < (b as any);
      else v = (a as any) <= (b as any);
    }
    return v;
  }

  function parseEq(): any {
    let v = parseRel();
    while (peek() && peek().type === 'op' && (peek().value === '==' || peek().value === '!=')) {
      const op = consume().value as string;
      const r = parseRel();
      const a = toComparable(v);
      const b = toComparable(r);
      v = op === '==' ? a === b : a !== b;
    }
    return v;
  }

  function parseAnd(): any {
    let v = parseEq();
    while (peek() && peek().type === 'op' && peek().value === '&&') {
      consume();
      const r = parseEq();
      v = truthy(v) && truthy(r);
    }
    return v;
  }

  function parseOr(): any {
    let v = parseAnd();
    while (peek() && peek().type === 'op' && peek().value === '||') {
      consume();
      const r = parseAnd();
      v = truthy(v) || truthy(r);
    }
    return v;
  }

  function truthy(v: any) {
    return !!v;
  }
  function toComparable(v: any) {
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
  }

  try {
    const res = parseOr();
    return res;
  } catch {
    return false;
  }
}
