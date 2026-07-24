/**
 * Heuristics for debug data that must never appear in an error body,
 * under any NODE_ENV. Curated to keep false positives rare: each pattern
 * targets something no intentional error message should contain.
 */

export interface LeakPattern {
  id: string;
  description: string;
  regex: RegExp;
}

export const LEAK_PATTERNS: LeakPattern[] = [
  {
    id: "stack-trace",
    description: "stack trace frame",
    regex: /\bat\s+(?:[\w.$<>\[\] ]+\s+\()?[^()\s]+:\d+:\d+\)?/,
  },
  {
    id: "node-modules-path",
    description: "node_modules path",
    regex: /node_modules[\\/]/,
  },
  {
    id: "filesystem-path",
    description: "absolute filesystem path",
    regex: /(?:[A-Za-z]:\\[\w\\.-]+|\/(?:home|Users|var|usr|opt|srv|etc|tmp)\/[\w./-]+)/,
  },
  {
    id: "sql-statement",
    description: "SQL statement",
    regex: /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,120}?\b(?:FROM|INTO|SET|WHERE)\b/i,
  },
  {
    id: "sql-error",
    description: "database error string",
    regex: /syntax error at or near|\bSQLSTATE\b|\bER_[A-Z_]{3,}\b|ORA-\d{5}|\bECONNREFUSED\b/i,
  },
  {
    id: "js-exception",
    description: "runtime exception message",
    regex: /\b(?:TypeError|ReferenceError|RangeError|SyntaxError)\b\s*:|Cannot read propert|is not a function\b/,
  },
  {
    id: "env-config",
    description: "environment/config reference",
    regex: /\bNODE_ENV\b|\bprocess\.env\b/,
  },
  {
    id: "internal-hostname",
    description: "internal hostname",
    regex: /\b[\w-]+\.(?:internal|intranet|corp|lan|cluster\.local)\b/i,
  },
  {
    id: "private-ip",
    description: "private IP address",
    regex:
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  },
];

export interface LeakHit {
  patternId: string;
  description: string;
  snippet: string;
}

export function scanForLeaks(text: string, allow: RegExp[] = []): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const pattern of LEAK_PATTERNS) {
    const match = pattern.regex.exec(text);
    if (!match) continue;
    if (allow.some((a) => a.test(match[0]))) continue;
    const start = Math.max(0, match.index - 20);
    const snippet = text.slice(start, match.index + match[0].length + 20).replace(/\s+/g, " ");
    hits.push({ patternId: pattern.id, description: pattern.description, snippet });
  }
  return hits;
}
