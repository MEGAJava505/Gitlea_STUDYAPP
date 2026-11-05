import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

const MAX_OUTPUT_BYTES = 8 * 1024;
const TIME_LIMIT_MS = 30_000;
const PYTHON_IMAGE_DIGEST = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface PythonTestJob {
  commitSha: string;
  bundleSha256: string;
  visibility: 'visible' | 'hidden';
}

export interface PythonWorkerPolicy {
  image: string;
  enabled: boolean;
  isolationVerified: boolean;
}

export interface MaterializedPythonInputs {
  commitSha: string;
  bundleSha256: string;
  snapshotPath: string;
  testsPath: string;
  dispose: () => Promise<void>;
}

export interface PythonExecutionResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface PythonWorkerDependencies {
  materialize: (job: PythonTestJob) => Promise<MaterializedPythonInputs>;
  execute?: (args: string[], timeoutMs?: number) => Promise<PythonExecutionResult>;
}

export interface PythonTestResult {
  status: 'passed' | 'failed' | 'error';
  commitSha: string;
  bundleSha256: string;
  output: string | null;
}

function validateMountPath(value: string, label: string): void {
  if (!isAbsolute(value) || /[,\r\n]/.test(value)) {
    throw new Error(`Invalid ${label} path for isolated test runner.`);
  }
}

function dockerArgs(policy: PythonWorkerPolicy, inputs: MaterializedPythonInputs, containerName: string): string[] {
  validateMountPath(inputs.snapshotPath, 'snapshot');
  validateMountPath(inputs.testsPath, 'tests');
  return [
    'run', '--rm', '--name', containerName,
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user=65534:65534',
    '--memory=256m',
    '--memory-swap=256m',
    '--cpus=1',
    '--pids-limit=64',
    '--ipc=none',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m',
    '--mount', `type=bind,src=${inputs.snapshotPath},dst=/workspace/submission,readonly`,
    '--mount', `type=bind,src=${inputs.testsPath},dst=/workspace/tests,readonly`,
    '--workdir=/workspace/submission',
    policy.image,
    'python', '-B', '-m', 'pytest', '-p', 'no:cacheprovider', '-q', '/workspace/tests',
  ];
}

function executeDocker(args: string[], timeoutMs = TIME_LIMIT_MS): Promise<PythonExecutionResult> {
  return new Promise((resolve) => {
    let output = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, output: output.toString('utf8').slice(0, MAX_OUTPUT_BYTES), timedOut, truncated });
    };

    let child;
    try {
      child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      finish(null);
      return;
    }

    const collect = (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - output.length;
      if (remaining > 0) output = Buffer.concat([output, chunk.subarray(0, remaining)]);
      if (chunk.length > remaining) truncated = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
  });
}

export async function runIsolatedPythonTests(
  job: PythonTestJob,
  policy: PythonWorkerPolicy,
  dependencies: PythonWorkerDependencies,
): Promise<PythonTestResult> {
  if (!policy.enabled) throw new Error('Python test worker is disabled.');
  if (!policy.isolationVerified) throw new Error('Python test worker isolation must be verified before enabling it.');
  if (!PYTHON_IMAGE_DIGEST.test(policy.image)) throw new Error('Python test worker image must be pinned by digest.');
  if (!SHA1.test(job.commitSha) || !SHA256.test(job.bundleSha256)) throw new Error('Test job identifiers are invalid.');

  const inputs = await dependencies.materialize(job);
  try {
    if (inputs.commitSha !== job.commitSha || inputs.bundleSha256 !== job.bundleSha256) {
      throw new Error('Materialized test inputs do not match the immutable commit and bundle.');
    }

    const containerName = `gitlea-test-${randomUUID()}`;
    let execution: PythonExecutionResult;
    let cleanupFailed = false;
    try {
      execution = await (dependencies.execute ?? executeDocker)(dockerArgs(policy, inputs, containerName), TIME_LIMIT_MS);
    } catch {
      execution = { code: null, output: '', timedOut: false, truncated: false };
    }

    if (execution.timedOut) {
      try {
        const cleanup = await (dependencies.execute ?? executeDocker)(['rm', '-f', containerName], 5_000);
        cleanupFailed = cleanup.code !== 0 || cleanup.timedOut;
      } catch {
        cleanupFailed = true;
      }
    }

    const status = execution.timedOut || cleanupFailed || execution.code === null
      ? 'error'
      : execution.code === 0 ? 'passed' : 'failed';
    return {
      status,
      commitSha: job.commitSha,
      bundleSha256: job.bundleSha256,
      output: job.visibility === 'hidden'
        ? null
        : status === 'error' ? 'Test runner error.' : execution.output.slice(0, MAX_OUTPUT_BYTES),
    };
  } finally {
    await inputs.dispose();
  }
}
