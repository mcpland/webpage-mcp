import fs from "node:fs";
import { pathToFileURL } from "node:url";

function median(values) {
  if (!values.length) return "—";
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summary(report) {
  const groups = new Map();
  for (const row of report.trials) {
    const key = row.task + "|" + row.adapter;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const lines = [
    "| Task | Adapter | Pass | Fail | Unsupported | Wrong writes | Tab activations | Median calls¹ | Median ms¹ |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const key of [...groups.keys()].sort()) {
    const rows = groups.get(key);
    const { task, adapter } = rows[0];
    const passed = rows.filter((r) => r.status === "pass");
    const failed = rows.filter((r) => r.status === "fail");
    const sum = (field) => rows.reduce((total, row) => total + row[field], 0);
    lines.push(
      "| " +
        [
          task,
          adapter + " " + report.versions[adapter],
          passed.length,
          failed.length,
          rows.length - passed.length - failed.length,
          sum("wrongTargetWrites"),
          sum("unexpectedTabActivations"),
          median(passed.map((r) => r.calls.length)),
          median(passed.map((r) => r.ms)),
        ].join(" | ") +
        " |",
    );
  }
  lines.push(
    "",
    "¹ Successful tasks only. Durations include fixture synchronization. Setup/runner errors: " +
      report.errors.length +
      ".",
  );
  return lines.join("\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length < 3)
    throw new Error("Pass the path to at least one benchmark JSON report");
  for (const file of process.argv.slice(2))
    console.log(
      file + "\n\n" + summary(JSON.parse(fs.readFileSync(file, "utf8"))),
    );
}
