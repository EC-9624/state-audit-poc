import fs from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import { getCapabilityFlags, resolveProfile, type AnalyzerProfile } from "./profiles";
import type { AnalyzerConfig, OutputFormat } from "./types";

export const DEFAULT_EXCLUDE_GLOBS = [
  "**/__tests__/**",
  "**/__storybook__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.stories.*",
];

export interface ParsedCliArgs {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

export interface AnalyzerConfigInput {
  root?: string;
  tsconfig?: string;
  include?: string[];
  exclude?: string[];
  format?: OutputFormat;
  profile?: string;
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const [key, inlineValue] = withoutPrefix.split("=", 2);

    if (inlineValue !== undefined) {
      pushArgValue(values, key, inlineValue);
      continue;
    }

    const maybeValue = argv[i + 1];
    if (maybeValue && !maybeValue.startsWith("--")) {
      pushArgValue(values, key, maybeValue);
      i += 1;
      continue;
    }

    flags.add(key);
  }

  return { positionals, values, flags };
}

export function getSingleArg(args: ParsedCliArgs, key: string): string | undefined {
  const values = args.values.get(key);
  if (!values || values.length === 0) {
    return undefined;
  }
  return values[values.length - 1];
}

export function getListArg(args: ParsedCliArgs, key: string): string[] {
  const raw = args.values.get(key) ?? [];
  const expanded: string[] = [];
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        expanded.push(trimmed);
      }
    }
  }
  return expanded;
}

export function createAnalyzerConfig(input: AnalyzerConfigInput): AnalyzerConfig {
  const rootDir = path.resolve(process.cwd(), input.root ?? ".");
  const explicitTsconfig = input.tsconfig
    ? path.resolve(process.cwd(), input.tsconfig)
    : undefined;
  const discoveredTsconfig = findNearestTsconfig(rootDir);
  const fallbackTsconfig = path.resolve(process.cwd(), "tsconfig.json");

  const tsconfigPath = explicitTsconfig
    ? ensureFileExists(explicitTsconfig, "tsconfig")
    : discoveredTsconfig ?? (fs.existsSync(fallbackTsconfig) ? fallbackTsconfig : undefined);

  const includeGlobs = input.include && input.include.length > 0 ? input.include : ["**/*.{ts,tsx}"];
  const excludeGlobs = [...DEFAULT_EXCLUDE_GLOBS, ...(input.exclude ?? [])];
  const format: OutputFormat = input.format ?? "text";
  const profile = resolveProfile(input.profile);

  return {
    rootDir,
    tsconfigPath,
    includeGlobs,
    excludeGlobs,
    format,
    profile,
    capabilities: getCapabilityFlags(profile),
  };
}

export function isFileInScope(config: AnalyzerConfig, filePath: string): boolean {
  const absoluteFilePath = path.resolve(filePath);
  if (!isDescendantPath(config.rootDir, absoluteFilePath)) {
    return false;
  }

  const relativePath = toPosixPath(path.relative(config.rootDir, absoluteFilePath));
  const included = config.includeGlobs.some((pattern) => minimatch(relativePath, pattern, { dot: true }));
  if (!included) {
    return false;
  }

  const excluded = config.excludeGlobs.some((pattern) => minimatch(relativePath, pattern, { dot: true }));
  return !excluded;
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function toDisplayPath(filePath: string): string {
  const absoluteFilePath = path.resolve(filePath);
  const relative = path.relative(process.cwd(), absoluteFilePath);
  const display = relative.length > 0 && !relative.startsWith("..") ? relative : absoluteFilePath;
  return toPosixPath(display);
}

function pushArgValue(store: Map<string, string[]>, key: string, value: string): void {
  const existing = store.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  store.set(key, [value]);
}

function ensureFileExists(filePath: string, label: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  return filePath;
}

function findNearestTsconfig(startDir: string): string | undefined {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, "tsconfig.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}

function isDescendantPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
