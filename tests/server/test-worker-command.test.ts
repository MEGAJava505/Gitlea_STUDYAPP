import { describe, expect, it } from 'vitest';
import { pythonWorkerCommand } from '../../src/server/test-worker-command';

describe('Python worker isolation command', () => {
  const valid = { isolationVerified: true, image: `python@sha256:${'a'.repeat(64)}`, containerName: 'studyapp-test-123', snapshotCommit: 'b'.repeat(40) };
  it('refuses activation before isolation verification and rejects mutable inputs', () => {
    expect(() => pythonWorkerCommand({ ...valid, isolationVerified: false })).toThrow();
    expect(() => pythonWorkerCommand({ ...valid, image: 'python:latest' })).toThrow();
    expect(() => pythonWorkerCommand({ ...valid, snapshotCommit: 'main' })).toThrow();
    expect(() => pythonWorkerCommand({ ...valid, containerName: '--privileged' })).toThrow();
  });
  it('constructs a nonprivileged networkless container without mounts or inherited environment', () => {
    const command = pythonWorkerCommand(valid);
    expect(command.executable).toBe('docker');
    for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534', '--memory=256m', '--cpus=1', '--pids-limit=64']) expect(command.args).toContain(flag);
    expect(command.timeoutMs).toBe(30_000);
    expect(command.args).not.toContain('--privileged');
    expect(command.args.some((arg) => arg.startsWith('--mount') || arg.startsWith('--volume') || arg.startsWith('--env'))).toBe(false);
    expect(command.args.slice(-5)).toEqual(['python', '-I', '-m', 'unittest', 'discover']);
  });
});
