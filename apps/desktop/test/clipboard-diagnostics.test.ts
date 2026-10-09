import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { unzipSync } from 'fflate';

const script = resolve('apps/desktop/scripts/collect_clipboard_diagnostics.ps1');
const launcher = resolve('apps/desktop/scripts/collect_clipboard_diagnostics.cmd');

test('clipboard collector has no content, keylogging, network, or destructive APIs', () => {
  assert.ok(existsSync(script), 'a standalone clipboard metadata collector must exist');
  const source = readFileSync(script, 'utf8');
  assert.match(source, /GetOpenClipboardWindow/u);
  assert.match(source, /GetClipboardOwner/u);
  assert.match(source, /GetClipboardSequenceNumber/u);
  assert.match(source, /GetForegroundWindow/u);
  for (const forbidden of [
    /\b(?:GetClipboardData|SetClipboardData|EmptyClipboard|GetWindowText|SetWindowsHookEx|RegisterHotKey|GetAsyncKeyState)\b/iu,
    /\b(?:Get-Clipboard|Set-Clipboard|Stop-Process|Remove-Item|Invoke-WebRequest|Invoke-RestMethod|SendKeys|taskkill)\b/iu,
    /\bCommandLine\b/iu,
  ]) assert.doesNotMatch(source, forbidden);
  assert.match(source, /finally\s*\{\s*CloseClipboard\(\);\s*\}/u);
  // ASCII source also runs correctly under Windows PowerShell 5.1 without a BOM.
  assert.doesNotMatch(source, /[^\x00-\x7f]/u);
  const command = readFileSync(launcher, 'utf8');
  assert.match(command, /powershell\.exe.*-NoProfile.*-File "%~dp0collect_clipboard_diagnostics\.ps1"/u);
  assert.doesNotMatch(command, /runas|taskkill|reg add/iu);
});

for (const probe of [false, true]) {
  test(`Windows PowerShell collector saves bounded metadata and a self-contained ZIP (access probe=${probe})`, {
    skip: process.platform !== 'win32', timeout: 30_000,
  }, () => {
    assert.ok(existsSync(script), 'the collector must exist before execution');
    const directory = mkdtempSync(join(tmpdir(), 'writing-clipboard-test-'));
    const output = join(directory, '中文 diagnostics');
    try {
      const result = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-DurationSeconds', '1', '-IntervalMilliseconds', '100', '-OutputDirectory', output,
        ...(probe ? ['-ProbeClipboardAccess'] : []),
      ], { encoding: 'utf8', timeout: 25_000, windowsHide: true });
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
      const entries = readdirSync(output);
      const reports = entries.filter(name => !name.endsWith('.zip'));
      assert.equal(reports.length, 1);
      const reportPath = join(output, reports[0]!);
      const report = JSON.parse(readFileSync(join(reportPath, 'report.json'), 'utf8'));
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.privacy.clipboardContentCollected, false);
      assert.equal(report.privacy.windowTitlesCollected, false);
      assert.equal(report.privacy.commandLinesCollected, false);
      assert.equal(report.capture.probeClipboardAccess, probe);
      assert.ok(report.summary.sampleCount >= 1);
      assert.ok(report.capture.elapsedMilliseconds < 10_000);
      assert.ok(Array.isArray(report.processSnapshots.start));
      assert.ok(Array.isArray(report.processSnapshots.end));
      assert.ok(Array.isArray(report.observedProcesses));
      assert.equal(report.summary.availabilityProbeSamples === 0, !probe);
      assert.match(readFileSync(join(reportPath, 'samples.csv'), 'utf8'), /Timestamp.*ClipboardSequence.*LockProcessId.*OwnerProcessId/u);
      assert.match(readFileSync(join(reportPath, 'README.txt'), 'utf8'), /not proof.*root cause/iu);
      const archives = entries.filter(name => name.endsWith('.zip'));
      assert.equal(archives.length, 1);
      const names = Object.keys(unzipSync(readFileSync(join(output, archives[0]!)))).map(name => name.split('/').at(-1));
      assert.deepEqual(names.sort(), ['README.txt', 'report.json', 'samples.csv']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('collector rejects an unbounded duration before collecting or writing anything', {
  skip: process.platform !== 'win32', timeout: 15_000,
}, () => {
  assert.ok(existsSync(script));
  const directory = mkdtempSync(join(tmpdir(), 'writing-clipboard-invalid-'));
  try {
    const output = join(directory, 'must-not-exist');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-DurationSeconds', '0', '-OutputDirectory', output,
    ], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(output), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
