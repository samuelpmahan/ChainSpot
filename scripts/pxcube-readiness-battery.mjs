import { PASS, FAIL, BLOCKED, runFlexibleBattery } from './pxcube-flexible-battery.mjs';

export async function runReadinessBattery(checks) {
  const checksOut=[];
  for (const entry of checks) {
    checksOut.push(await runFlexibleBattery(entry.check, entry.adapters));
  }
  const statuses=checksOut.map(x=>x.result.status);
  const status=statuses.includes(FAIL) ? FAIL : statuses.includes(BLOCKED) ? BLOCKED : PASS;
  return {kind:'pxcube.readiness',status,checks:checksOut};
}

export function formatReadiness(result) {
  const lines=[`PXCUBE READINESS — ${result.status}`];
  for(const check of result.checks) {
    lines.push(`${check.result.check}: ${check.result.status} via ${check.result.fulfillment ?? 'none'}`);
    for(const attempt of check.attempts) lines.push(`  ${attempt.adapter}: ${attempt.status}`);
  }
  return lines.join('\n');
}
