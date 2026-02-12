#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createAnalyzerConfig, getSingleArg, parseCliArgs } from "../core/config";
import { runAudit } from "../core/analyzer";
import { toSerializableAuditReport } from "../core/reporter";

interface FixtureResult {
  fixture: string;
  ok: boolean;
  reason?: string;
}

function main(): void {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const fixtureRoot = path.resolve(process.cwd(), getSingleArg(args, "fixtures") ?? "fixtures");
    const format = getSingleArg(args, "format") ?? "text";

    const fixtureNames = fs
      .readdirSync(fixtureRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    const results: FixtureResult[] = [];

    for (const fixtureName of fixtureNames) {
      const fixtureDir = path.join(fixtureRoot, fixtureName);
      const srcDir = path.join(fixtureDir, "src");
      const expectedPath = path.join(fixtureDir, "expected.json");

      if (!fs.existsSync(srcDir)) {
        results.push({ fixture: fixtureName, ok: false, reason: "missing src directory" });
        continue;
      }
      if (!fs.existsSync(expectedPath)) {
        results.push({ fixture: fixtureName, ok: false, reason: "missing expected.json" });
        continue;
      }

      const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
      const config = createAnalyzerConfig({
        root: srcDir,
        format: "json",
      });

      const actual = toSerializableAuditReport(runAudit(config));
      const ok = isSubsetMatch(actual, expected);

      results.push({
        fixture: fixtureName,
        ok,
        reason: ok ? undefined : "actual output does not satisfy expected semantic subset",
      });
    }

    const passed = results.filter((result) => result.ok).length;
    const failed = results.length - passed;

    if (format === "json") {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: failed === 0,
            summary: {
              total: results.length,
              passed,
              failed,
            },
            results,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(renderTextResults(results, passed, failed));
    }

    process.exitCode = failed === 0 ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`run-fixtures error: ${message}\n`);
    process.exitCode = 2;
  }
}

function renderTextResults(results: FixtureResult[], passed: number, failed: number): string {
  const lines: string[] = [];
  lines.push(`Fixtures: total=${results.length} passed=${passed} failed=${failed}`);
  for (const result of results) {
    if (result.ok) {
      lines.push(`- PASS ${result.fixture}`);
    } else {
      lines.push(`- FAIL ${result.fixture} ${result.reason ?? "unknown error"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function isSubsetMatch(actual: unknown, expected: unknown): boolean {
  if (expected === null || expected === undefined) {
    return actual === expected;
  }

  if (typeof expected !== "object") {
    return Object.is(actual, expected);
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return false;
    }

    const used = new Set<number>();
    for (const expectedItem of expected) {
      let matched = false;
      for (let i = 0; i < actual.length; i += 1) {
        if (used.has(i)) {
          continue;
        }
        if (isSubsetMatch(actual[i], expectedItem)) {
          used.add(i);
          matched = true;
          break;
        }
      }
      if (!matched) {
        return false;
      }
    }

    return true;
  }

  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
    return false;
  }

  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;

  for (const [key, expectedValue] of Object.entries(expectedRecord)) {
    if (!(key in actualRecord)) {
      return false;
    }
    if (!isSubsetMatch(actualRecord[key], expectedValue)) {
      return false;
    }
  }

  return true;
}

main();
