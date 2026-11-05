export interface PythonWorkerCommandInput {
  isolationVerified: boolean;
  image: string;
  containerName: string;
  snapshotCommit: string;
}

export interface WorkerCommand {
  executable: 'docker';
  args: string[];
  timeoutMs: number;
}

const IMAGE_RE = /^python@sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function pythonWorkerCommand(input: PythonWorkerCommandInput): WorkerCommand {
  if (!input.isolationVerified) throw new Error('worker isolation must be verified');
  if (!IMAGE_RE.test(input.image)) throw new Error('worker image must be pinned by digest');
  if (!COMMIT_RE.test(input.snapshotCommit)) throw new Error('snapshot commit must be a full SHA');
  if (!NAME_RE.test(input.containerName)) throw new Error('invalid container name');

  return {
    executable: 'docker',
    timeoutMs: 30_000,
    args: [
      'run', '--rm', '--name', input.containerName,
      '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--user=65534:65534',
      '--memory=256m', '--cpus=1', '--pids-limit=64',
      input.image, 'python', '-I', '-m', 'unittest', 'discover',
    ],
  };
}
