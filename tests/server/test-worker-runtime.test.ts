import { describe, expect, it, vi } from 'vitest';
import { runIsolatedPythonTests } from '../../src/server/test-worker-runtime';

const job = { commitSha: 'a'.repeat(40), bundleSha256: 'b'.repeat(64), visibility: 'hidden' as const };
const image = 'python@sha256:' + 'c'.repeat(64);
function setup() {
  const execute = vi.fn(async () => ({ code: 0, output: 'PRIVATE assertions', timedOut: false, truncated: false }));
  const dispose = vi.fn(async () => {});
  const materialize = vi.fn(async () => ({ commitSha: job.commitSha, bundleSha256: job.bundleSha256, snapshotPath: '/tmp/snapshot', testsPath: '/tmp/tests', dispose }));
  return { execute, dispose, materialize };
}
describe('isolated Python worker boundary', () => {
  it('fails closed unless explicitly enabled and isolation verified', async () => {
    const deps = setup();
    await expect(runIsolatedPythonTests(job, { image, enabled: false, isolationVerified: true }, deps)).rejects.toThrow(/disabled/);
    await expect(runIsolatedPythonTests(job, { image, enabled: true, isolationVerified: false }, deps)).rejects.toThrow(/verified/);
    expect(deps.materialize).not.toHaveBeenCalled();
  });
  it('pins snapshot and bundle, applies isolation limits, redacts hidden output, and cleans up', async () => {
    const deps = setup();
    const result = await runIsolatedPythonTests(job, { image, enabled: true, isolationVerified: true }, deps);
    const args = deps.execute.mock.calls[0][0];
    expect(args).toEqual(expect.arrayContaining([
      '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--user=65534:65534', '--memory=256m', '--memory-swap=256m', '--cpus=1', '--pids-limit=64',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m', image,
    ]));
    expect(args).toContain('type=bind,src=/tmp/snapshot,dst=/workspace/submission,readonly');
    expect(args).toContain('type=bind,src=/tmp/tests,dst=/workspace/tests,readonly');
    expect(args.join(' ')).not.toMatch(/privileged|docker.sock|--env-file/);
    expect(result).toMatchObject({ status: 'passed', output: null, commitSha: job.commitSha });
    expect(deps.dispose).toHaveBeenCalledOnce();
  });
  it('rejects mutable image tags and mismatched immutable inputs before execution', async () => {
    const deps = setup();
    await expect(runIsolatedPythonTests(job, { image: 'python:latest', enabled: true, isolationVerified: true }, deps)).rejects.toThrow(/digest/);
    deps.materialize.mockResolvedValueOnce({ commitSha: 'd'.repeat(40), bundleSha256: job.bundleSha256, snapshotPath: '/tmp/snapshot', testsPath: '/tmp/tests', dispose: deps.dispose });
    await expect(runIsolatedPythonTests(job, { image, enabled: true, isolationVerified: true }, deps)).rejects.toThrow(/immutable/);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.dispose).toHaveBeenCalledOnce();
  });
  it('maps timeout to error and bounds visible output', async () => {
    const deps = setup();
    deps.execute.mockResolvedValueOnce({ code: null as unknown as number, output: 'x'.repeat(9000), timedOut: true, truncated: true });
    const result = await runIsolatedPythonTests({ ...job, visibility: 'visible' }, { image, enabled: true, isolationVerified: true }, deps);
    expect(result.status).toBe('error');
    expect(result.output?.length).toBeLessThanOrEqual(8192);
    expect(deps.execute.mock.calls[1][0][0]).toBe('rm');
  });
});
