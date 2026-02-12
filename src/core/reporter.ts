import { toDisplayPath } from "./config";
import type { AuditReport, ImpactReport } from "./types";

export function toSerializableAuditReport(report: AuditReport): AuditReport {
  return {
    ok: report.ok,
    summary: {
      violations: report.summary.violations,
    },
    violations: report.violations.map((violation) => ({
      ...violation,
      file: toDisplayPath(violation.file),
    })),
  };
}

export function renderAuditText(report: AuditReport): string {
  const serializable = toSerializableAuditReport(report);
  if (serializable.ok) {
    return "Audit PASS (0 violations)";
  }

  const lines: string[] = [`Audit FAIL (${serializable.summary.violations} violation${serializable.summary.violations === 1 ? "" : "s"})`];

  for (const violation of serializable.violations) {
    lines.push(
      `- ${violation.rule} ${violation.state} ${violation.file}:${violation.line} ${violation.message}`,
    );
    if (violation.metrics) {
      const metricText = Object.entries(violation.metrics)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}=${value}`)
        .join(" ");
      lines.push(`  metrics ${metricText}`);
    }
  }

  return lines.join("\n");
}

export function toSerializableImpactReport(report: ImpactReport): ImpactReport {
  return {
    ...report,
    items: report.items.map((item) => ({
      ...item,
      definition: {
        ...item.definition,
        file: toDisplayPath(item.definition.file),
      },
      directReaders: mapWithDisplayPath(item.directReaders),
      runtimeWriters: mapWithDisplayPath(item.runtimeWriters),
      initWriters: mapWithDisplayPath(item.initWriters),
      transitiveDependents: mapWithDisplayPath(item.transitiveDependents),
    })),
  };
}

export function renderImpactText(report: ImpactReport): string {
  const serializable = toSerializableImpactReport(report);
  const lines: string[] = [];
  lines.push(
    `Impact (${serializable.query.mode}=${serializable.query.value}, depth=${serializable.query.depth})`,
  );

  for (const item of serializable.items) {
    lines.push(`- State ${item.state} (${item.store}/${item.kind})`);
    lines.push(`  definition ${item.definition.file}:${item.definition.line}`);

    lines.push(`  directReaders ${item.directReaders.length}`);
    for (const reader of item.directReaders) {
      lines.push(`    - ${reader.actor} ${reader.file}:${reader.line} via ${reader.via}`);
    }

    lines.push(`  runtimeWriters ${item.runtimeWriters.length}`);
    for (const writer of item.runtimeWriters) {
      lines.push(`    - ${writer.actor} ${writer.file}:${writer.line} via ${writer.via}`);
    }

    lines.push(`  initWriters ${item.initWriters.length}`);
    for (const writer of item.initWriters) {
      lines.push(`    - ${writer.actor} ${writer.file}:${writer.line} via ${writer.via}`);
    }

    lines.push(`  transitiveDependents ${item.transitiveDependents.length}`);
    for (const dependent of item.transitiveDependents) {
      lines.push(`    - ${dependent.state} depth=${dependent.depth} ${dependent.file}:${dependent.line}`);
    }
  }

  return lines.join("\n");
}

function mapWithDisplayPath<T extends { file: string }>(items: T[]): T[] {
  return items.map((item) => ({
    ...item,
    file: toDisplayPath(item.file),
  }));
}
