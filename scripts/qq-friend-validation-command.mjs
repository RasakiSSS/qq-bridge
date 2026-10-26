// Local maintenance client. Does not start QQ or load a native module.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { package: { type: 'string' }, action: { type: 'string' } } });
try {
  if (!values.package || !['status', 'preflight', 'send-once'].includes(values.action)) throw Error('Invalid action');
  const config = JSON.parse(fs.readFileSync(path.join(values.package, 'qq-bridge-friend-probe', 'config.json'), 'utf8'));
  const report = JSON.parse(fs.readFileSync(path.join(config.reportDir, 'validation.json'), 'utf8'));
  if (!report.active || !Number.isInteger(report.port) || report.port < 1 || report.port > 65535) throw Error('No active validation endpoint');
  const response = await fetch('http://127.0.0.1:' + report.port + '/' + values.action, {
    method: values.action === 'status' ? 'GET' : 'POST', headers: { 'x-maintenance-token': config.controlToken },
    redirect: 'error', signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw Error('Validation endpoint rejected command');
  console.log(JSON.stringify(await response.json(), null, 2));
} catch { console.error('Validation command unavailable or failed. Do not retry an uncertain send; inspect its journal and report.'); process.exitCode = 1; }
