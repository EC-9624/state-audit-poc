#!/usr/bin/env node

import { createAnalyzerConfig, getListArg, getSingleArg, parseCliArgs } from "../core/config";
import { runAudit } from "../core/analyzer";
import { renderAuditText, toSerializableAuditReport } from "../core/reporter";
import type { OutputFormat } from "../core/types";

function main(): void {
  try {
    const args = parseCliArgs(process.argv.slice(2));

    const format = parseFormat(getSingleArg(args, "format"));
    const config = createAnalyzerConfig({
      root: getSingleArg(args, "root"),
      tsconfig: getSingleArg(args, "tsconfig"),
      include: getListArg(args, "include"),
      exclude: getListArg(args, "exclude"),
      format,
      profile: getSingleArg(args, "profile"),
    });

    const report = runAudit(config);
    if (format === "json") {
      process.stdout.write(`${JSON.stringify(toSerializableAuditReport(report), null, 2)}\n`);
    } else {
      process.stdout.write(`${renderAuditText(report)}\n`);
    }

    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`state:audit error: ${message}\n`);
    process.exitCode = 2;
  }
}

function parseFormat(value: string | undefined): OutputFormat {
  if (!value) {
    return "text";
  }

  if (value === "text" || value === "json") {
    return value;
  }

  throw new Error(`Unsupported format: ${value}`);
}

main();
