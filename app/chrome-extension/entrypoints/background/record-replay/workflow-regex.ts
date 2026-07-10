import {
  RegExpParser,
  visitRegExpAST,
  type AST,
} from '@eslint-community/regexpp';

/**
 * Runtime guard for user-authored workflow regular expressions.
 *
 * JavaScript has no reliable way to interrupt a synchronous RegExp match. Both
 * operands are bounded, then a complete ECMAScript AST is checked for unsafe
 * constructs and overlapping repetitions before a native RegExp is created.
 */

export const WORKFLOW_REGEX_PATTERN_MAX_UTF8_BYTES = 4 * 1024;
export const WORKFLOW_REGEX_INPUT_MAX_UTF8_BYTES = 64 * 1024;
export const WORKFLOW_REGEX_BATCH_INPUT_MAX_UTF8_BYTES = 1024 * 1024;

const WORKFLOW_REGEX_MAX_GROUP_DEPTH = 32;
const WORKFLOW_REGEX_MAX_FINITE_REPETITION = 1_000;
const WORKFLOW_REGEX_MAX_QUANTIFIERS = 64;
const WORKFLOW_REGEX_ANALYSIS_CACHE_MAX_ENTRIES = 32;
const WORKFLOW_REGEX_FLAGS_MAX_UTF8_BYTES = 16;
const WORKFLOW_REGEX_ALLOWED_FLAGS = new Set(['g', 'i', 'm', 's', 'u', 'y']);
const MAX_CODE_POINT = 0x10ffff;
const REGEXP_PARSER = new RegExpParser({ ecmaVersion: 2024 });
const ANALYSIS_CACHE = new Map<string, WorkflowRegexPatternResult>();

export type WorkflowRegexErrorCode =
  | 'WORKFLOW_REGEX_PATTERN_TOO_LARGE'
  | 'WORKFLOW_REGEX_INPUT_TOO_LARGE'
  | 'WORKFLOW_REGEX_UNSAFE'
  | 'WORKFLOW_REGEX_INVALID';

export interface WorkflowRegexFailure {
  ok: false;
  code: WorkflowRegexErrorCode;
  message: string;
}

export type WorkflowRegexPatternResult = { ok: true } | WorkflowRegexFailure;
export type WorkflowRegexTestResult =
  | { ok: true; matched: boolean }
  | WorkflowRegexFailure;

type CodePointRange = readonly [start: number, end: number];

interface CharacterDomain {
  ranges: CodePointRange[];
  unknown: boolean;
}

interface RegexFlags {
  dotAll: boolean;
  ignoreCase: boolean;
  unicode: boolean;
}

function failure(code: WorkflowRegexErrorCode, message: string): WorkflowRegexFailure {
  return { ok: false, code, message };
}

function invalidPattern(): WorkflowRegexFailure {
  return failure(
    'WORKFLOW_REGEX_INVALID',
    'Workflow regex pattern is not a valid supported regular expression.',
  );
}

function unsafePattern(reason: string): WorkflowRegexFailure {
  return failure('WORKFLOW_REGEX_UNSAFE', `Workflow regex pattern is unsafe: ${reason}`);
}

export function measureWorkflowRegexUtf8Bytes(
  value: string,
  maximumBytes: number,
): number | null {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (bytes > maximumBytes) return null;
  }
  return bytes;
}

export function validateWorkflowRegexPatternSize(
  source: string,
): WorkflowRegexPatternResult {
  return measureWorkflowRegexUtf8Bytes(source, WORKFLOW_REGEX_PATTERN_MAX_UTF8_BYTES) !== null
    ? { ok: true }
    : failure(
        'WORKFLOW_REGEX_PATTERN_TOO_LARGE',
        `Workflow regex pattern exceeds ${WORKFLOW_REGEX_PATTERN_MAX_UTF8_BYTES} UTF-8 bytes.`,
      );
}

function validateFlags(flags: string): WorkflowRegexPatternResult {
  if (measureWorkflowRegexUtf8Bytes(flags, WORKFLOW_REGEX_FLAGS_MAX_UTF8_BYTES) === null) {
    return invalidPattern();
  }
  const seen = new Set<string>();
  for (const flag of flags) {
    if (!WORKFLOW_REGEX_ALLOWED_FLAGS.has(flag) || seen.has(flag)) {
      return invalidPattern();
    }
    seen.add(flag);
  }
  return { ok: true };
}

/** Bound parser recursion before handing the source to the AST parser. */
function hasAllowedGroupDepth(source: string): boolean {
  let depth = 0;
  let inCharacterClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const token = source[index];
    if (token === '\\') {
      index += 1;
      continue;
    }
    if (token === '[' && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (token === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (token === '(') {
      depth += 1;
      if (depth > WORKFLOW_REGEX_MAX_GROUP_DEPTH) return false;
    } else if (token === ')' && depth > 0) {
      depth -= 1;
    }
  }
  return true;
}

function normalizeRanges(ranges: CodePointRange[]): CodePointRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const normalized: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const previous = normalized[normalized.length - 1];
    if (previous && start <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], end);
    } else {
      normalized.push([start, end]);
    }
  }
  return normalized;
}

function knownDomain(...ranges: CodePointRange[]): CharacterDomain {
  return { ranges: normalizeRanges(ranges), unknown: false };
}

function unknownDomain(): CharacterDomain {
  return { ranges: [], unknown: true };
}

function unionDomains(domains: CharacterDomain[]): CharacterDomain {
  if (domains.some((domain) => domain.unknown)) return unknownDomain();
  return knownDomain(...domains.flatMap((domain) => domain.ranges));
}

function complementDomain(domain: CharacterDomain): CharacterDomain {
  if (domain.unknown) return unknownDomain();
  const ranges = normalizeRanges(domain.ranges);
  const complement: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (cursor < start) complement.push([cursor, start - 1]);
    cursor = Math.max(cursor, end + 1);
  }
  if (cursor <= MAX_CODE_POINT) complement.push([cursor, MAX_CODE_POINT]);
  return knownDomain(...complement);
}

function domainsOverlap(left: CharacterDomain, right: CharacterDomain): boolean {
  if (left.unknown || right.unknown) return true;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.ranges.length && rightIndex < right.ranges.length) {
    const leftRange = left.ranges[leftIndex];
    const rightRange = right.ranges[rightIndex];
    if (leftRange[1] < rightRange[0]) {
      leftIndex += 1;
    } else if (rightRange[1] < leftRange[0]) {
      rightIndex += 1;
    } else {
      return true;
    }
  }
  return false;
}

function domainsAreProvablyDisjoint(
  left: CharacterDomain,
  right: CharacterDomain,
): boolean {
  return !left.unknown && !right.unknown && !domainsOverlap(left, right);
}

function flagsFromString(flags: string): RegexFlags {
  return {
    dotAll: flags.includes('s'),
    ignoreCase: flags.includes('i'),
    unicode: flags.includes('u'),
  };
}

function characterDomain(value: number, flags: RegexFlags): CharacterDomain {
  if (flags.ignoreCase) {
    // Full Unicode canonicalization is deliberately treated as unknown. This
    // keeps overlap decisions fail-closed without reimplementing case folding.
    return unknownDomain();
  }
  return knownDomain([value, value]);
}

function baseCharacterSetDomain(kind: 'digit' | 'space' | 'word'): CharacterDomain {
  switch (kind) {
    case 'digit':
      return knownDomain([0x30, 0x39]);
    case 'word':
      return knownDomain([0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]);
    case 'space':
      return knownDomain(
        [0x0009, 0x000d],
        [0x0020, 0x0020],
        [0x00a0, 0x00a0],
        [0x1680, 0x1680],
        [0x2000, 0x200a],
        [0x2028, 0x2029],
        [0x202f, 0x202f],
        [0x205f, 0x205f],
        [0x3000, 0x3000],
        [0xfeff, 0xfeff],
      );
  }
}

function characterSetDomain(node: AST.CharacterSet, flags: RegexFlags): CharacterDomain {
  if (node.kind === 'any') {
    return flags.dotAll
      ? knownDomain([0, MAX_CODE_POINT])
      : complementDomain(
          knownDomain(
            [0x000a, 0x000a],
            [0x000d, 0x000d],
            [0x2028, 0x2029],
          ),
        );
  }
  if (node.kind === 'property') return unknownDomain();
  if (flags.ignoreCase && node.kind === 'word') return unknownDomain();
  const base = baseCharacterSetDomain(node.kind);
  return node.negate ? complementDomain(base) : base;
}

function characterClassDomain(
  node: AST.CharacterClass,
  flags: RegexFlags,
): CharacterDomain {
  if (node.unicodeSets || flags.ignoreCase) return unknownDomain();
  const domains: CharacterDomain[] = [];
  for (const element of node.elements) {
    switch (element.type) {
      case 'Character':
        domains.push(characterDomain(element.value, flags));
        break;
      case 'CharacterClassRange':
        domains.push(knownDomain([element.min.value, element.max.value]));
        break;
      case 'CharacterSet':
        domains.push(characterSetDomain(element, flags));
        break;
      default:
        return unknownDomain();
    }
  }
  const domain = unionDomains(domains);
  return node.negate ? complementDomain(domain) : domain;
}

function elementDomain(element: AST.Element, flags: RegexFlags): CharacterDomain {
  switch (element.type) {
    case 'Character':
      return characterDomain(element.value, flags);
    case 'CharacterClass':
      return characterClassDomain(element, flags);
    case 'CharacterSet':
      return characterSetDomain(element, flags);
    case 'Group':
    case 'CapturingGroup':
      return unionDomains(
        element.alternatives.map((alternative) => alternativeDomain(alternative, flags)),
      );
    case 'Quantifier':
      return elementDomain(element.element, flags);
    case 'Backreference':
      return unknownDomain();
    case 'Assertion':
      return knownDomain();
    default:
      return unknownDomain();
  }
}

function alternativeDomain(
  alternative: AST.Alternative,
  flags: RegexFlags,
): CharacterDomain {
  return unionDomains(alternative.elements.map((element) => elementDomain(element, flags)));
}

function minimumConsumedCharacters(element: AST.Element): number {
  switch (element.type) {
    case 'Character':
    case 'CharacterClass':
    case 'CharacterSet':
      return 1;
    case 'Assertion':
    case 'Backreference':
      return 0;
    case 'Group':
    case 'CapturingGroup':
      return element.alternatives.length === 0
        ? 0
        : Math.min(
            ...element.alternatives.map((alternative) =>
              alternative.elements.reduce(
                (total, nested) => total + minimumConsumedCharacters(nested),
                0,
              ),
            ),
          );
    case 'Quantifier':
      return minimumConsumedCharacters(element.element) * element.min;
    default:
      return 0;
  }
}

function containsVariableQuantifier(node: AST.Node): boolean {
  let found = false;
  visitRegExpAST(node, {
    onQuantifierEnter: (quantifier) => {
      if (quantifier.min !== quantifier.max) found = true;
    },
  });
  return found;
}

function quantifiedGroupHasRiskyDescendant(
  group: AST.Group | AST.CapturingGroup,
): boolean {
  if (group.alternatives.length > 1) return true;
  let risky = false;
  visitRegExpAST(group, {
    onGroupEnter: (nested) => {
      if (nested !== group && nested.alternatives.length > 1) risky = true;
    },
    onCapturingGroupEnter: (nested) => {
      if (nested !== group && nested.alternatives.length > 1) risky = true;
    },
    onQuantifierEnter: () => {
      risky = true;
    },
  });
  return risky;
}

function flattenTransparentGroups(elements: AST.Element[]): AST.Element[] {
  const flattened: AST.Element[] = [];
  for (const element of elements) {
    if (
      (element.type === 'Group' || element.type === 'CapturingGroup') &&
      element.alternatives.length === 1
    ) {
      flattened.push(...flattenTransparentGroups(element.alternatives[0].elements));
    } else {
      flattened.push(element);
    }
  }
  return flattened;
}

function hasMandatoryBarrier(
  elements: AST.Element[],
  startIndex: number,
  endIndex: number,
  leftDomain: CharacterDomain,
  rightDomain: CharacterDomain,
  flags: RegexFlags,
): boolean {
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const element = elements[index];
    if (minimumConsumedCharacters(element) <= 0) continue;
    const barrierDomain = elementDomain(element, flags);
    if (
      domainsAreProvablyDisjoint(barrierDomain, leftDomain) ||
      domainsAreProvablyDisjoint(barrierDomain, rightDomain)
    ) {
      return true;
    }
  }
  return false;
}

function findOverlappingRepetition(
  alternative: AST.Alternative,
  flags: RegexFlags,
): WorkflowRegexFailure | null {
  const elements = flattenTransparentGroups(alternative.elements);
  const repetitions = elements.flatMap((element, index) =>
    element.type === 'Quantifier' && element.min !== element.max
      ? [{ index, domain: elementDomain(element.element, flags) }]
      : [],
  );

  for (let leftIndex = 0; leftIndex < repetitions.length; leftIndex += 1) {
    const left = repetitions[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < repetitions.length; rightIndex += 1) {
      const right = repetitions[rightIndex];
      if (!domainsOverlap(left.domain, right.domain)) continue;
      if (
        hasMandatoryBarrier(
          elements,
          left.index,
          right.index,
          left.domain,
          right.domain,
          flags,
        )
      ) {
        continue;
      }
      return unsafePattern(
        'multiple variable repetitions can consume overlapping input.',
      );
    }
  }
  return null;
}

function analyzePattern(
  pattern: AST.Pattern,
  flags: RegexFlags,
): WorkflowRegexPatternResult {
  let quantifierCount = 0;
  visitRegExpAST(pattern, {
    onQuantifierEnter: () => {
      quantifierCount += 1;
    },
  });
  if (quantifierCount > WORKFLOW_REGEX_MAX_QUANTIFIERS) {
    return unsafePattern(
      `pattern contains more than ${WORKFLOW_REGEX_MAX_QUANTIFIERS} quantifiers.`,
    );
  }

  let rejection: WorkflowRegexFailure | null = null;
  visitRegExpAST(pattern, {
    onAssertionEnter: (assertion) => {
      if (
        !rejection &&
        (assertion.kind === 'lookahead' || assertion.kind === 'lookbehind')
      ) {
        rejection = unsafePattern('lookaround assertions are not allowed.');
      }
    },
    onBackreferenceEnter: () => {
      rejection ??= unsafePattern('backreferences are not allowed.');
    },
    onGroupEnter: (group) => {
      if (
        !rejection &&
        group.alternatives.length > 1 &&
        containsVariableQuantifier(group)
      ) {
        rejection = unsafePattern(
          'alternation branches may not contain variable repetitions.',
        );
      }
    },
    onCapturingGroupEnter: (group) => {
      if (
        !rejection &&
        group.alternatives.length > 1 &&
        containsVariableQuantifier(group)
      ) {
        rejection = unsafePattern(
          'alternation branches may not contain variable repetitions.',
        );
      }
    },
    onQuantifierEnter: (quantifier) => {
      if (rejection) return;
      if (
        quantifier.min > WORKFLOW_REGEX_MAX_FINITE_REPETITION ||
        (Number.isFinite(quantifier.max) &&
          quantifier.max > WORKFLOW_REGEX_MAX_FINITE_REPETITION)
      ) {
        rejection = unsafePattern(
          `repetition bound exceeds ${WORKFLOW_REGEX_MAX_FINITE_REPETITION}.`,
        );
        return;
      }
      if (
        (quantifier.element.type === 'Group' ||
          quantifier.element.type === 'CapturingGroup') &&
        (minimumConsumedCharacters(quantifier.element) === 0 ||
          quantifiedGroupHasRiskyDescendant(quantifier.element))
      ) {
        rejection = unsafePattern(
          'a quantified group may not be empty or contain alternation or another quantifier.',
        );
      }
    },
    onAlternativeEnter: (alternative) => {
      rejection ??= findOverlappingRepetition(alternative, flags);
    },
  });
  return rejection ?? { ok: true };
}

function parsePattern(source: string, flags: string): AST.Pattern | WorkflowRegexFailure {
  if (!hasAllowedGroupDepth(source)) {
    return unsafePattern(`group nesting exceeds ${WORKFLOW_REGEX_MAX_GROUP_DEPTH}.`);
  }
  try {
    return REGEXP_PARSER.parsePattern(source, 0, source.length, {
      unicode: flags.includes('u'),
      unicodeSets: false,
    });
  } catch {
    return invalidPattern();
  }
}

function analyzeSource(source: string, flags: string): WorkflowRegexPatternResult {
  const cacheKey = `${flags}\u0000${source}`;
  const cached = ANALYSIS_CACHE.get(cacheKey);
  if (cached) return cached;

  const parsed = parsePattern(source, flags);
  const result =
    'ok' in parsed ? parsed : analyzePattern(parsed, flagsFromString(flags));
  if (ANALYSIS_CACHE.size >= WORKFLOW_REGEX_ANALYSIS_CACHE_MAX_ENTRIES) {
    const oldestKey = ANALYSIS_CACHE.keys().next().value;
    if (typeof oldestKey === 'string') ANALYSIS_CACHE.delete(oldestKey);
  }
  ANALYSIS_CACHE.set(cacheKey, result);
  return result;
}

function constructRegex(source: string, flags: string): RegExp | WorkflowRegexFailure {
  try {
    return new RegExp(source, flags);
  } catch {
    return invalidPattern();
  }
}

export function validateWorkflowRegexPattern(
  source: string,
  flags = '',
): WorkflowRegexPatternResult {
  const sizeResult = validateWorkflowRegexPatternSize(source);
  if (!sizeResult.ok) return sizeResult;
  const flagsResult = validateFlags(flags);
  if (!flagsResult.ok) return flagsResult;
  const analysis = analyzeSource(source, flags);
  if (!analysis.ok) return analysis;
  const regex = constructRegex(source, flags);
  return regex instanceof RegExp ? { ok: true } : regex;
}

export function testWorkflowRegex(
  source: string,
  input: string,
  flags = '',
): WorkflowRegexTestResult {
  const sizeResult = validateWorkflowRegexPatternSize(source);
  if (!sizeResult.ok) return sizeResult;
  if (measureWorkflowRegexUtf8Bytes(input, WORKFLOW_REGEX_INPUT_MAX_UTF8_BYTES) === null) {
    return failure(
      'WORKFLOW_REGEX_INPUT_TOO_LARGE',
      `Workflow regex input exceeds ${WORKFLOW_REGEX_INPUT_MAX_UTF8_BYTES} UTF-8 bytes.`,
    );
  }
  const flagsResult = validateFlags(flags);
  if (!flagsResult.ok) return flagsResult;
  const analysis = analyzeSource(source, flags);
  if (!analysis.ok) return analysis;
  const regex = constructRegex(source, flags);
  if (!(regex instanceof RegExp)) return regex;
  return { ok: true, matched: regex.test(input) };
}
