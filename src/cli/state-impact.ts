#!/usr/bin/env node

import { createAnalyzerConfig, getListArg, getSingleArg, parseCliArgs } from "../core/config";
import { runImpact } from "../core/impact";
import { renderImpactText, toSerializableImpactReport } from "../core/reporter";
import type { OutputFormat } from "../core/types";

function main(): void {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const format = parseFormat(getSingleArg(args, "format"));

    const stateName = getSingleArg(args, "state");
    const filePath = getSingleArg(args, "file");
    const modeCount = Number(Boolean(stateName)) + Number(Boolean(filePath));
    if (modeCount !== 1) {
      throw new Error("Exactly one query mode is required: --state <name> or --file <path>");
    }

    const depthRaw = getSingleArg(args, "depth");
    const depth = depthRaw ? parseInteger(depthRaw, "depth") : 2;

    const config = createAnalyzerConfig({
      root: getSingleArg(args, "root"),
      tsconfig: getSingleArg(args, "tsconfig"),
      include: getListArg(args, "include"),
      exclude: getListArg(args, "exclude"),
      format,
    });

    const report = runImpact(config, {
      state: stateName,
      file: filePath,
      depth,
    });

    if (format === "json") {
      process.stdout.write(`${JSON.stringify(toSerializableImpactReport(report), null, 2)}\n`);
    } else {
      process.stdout.write(`${renderImpactText(report)}\n`);
    }

    process.exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`state:impact error: ${message}\n`);
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

function parseInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

main();
