import { createHmac, randomInt } from 'node:crypto';
import { errors } from '../shared/contracts';

/** The adapter must atomically reserve a fingerprint globally, including across processes. */
export interface PasswordFingerprintRepository {
  reserve(fingerprint: string): Promise<boolean>;
}

interface PasswordDeps {
  fingerprints: PasswordFingerprintRepository;
  /** Separate, protected key for issued-password fingerprints; never persist plaintext. */
  hmacSecret: string;
  randomInt?: (max: number) => number;
}

/** Initial issued-password policy from PLAN_GITEA §4.5. */
export function isValidPassword(password: string): boolean {
  if (password.length !== 7 || !/^[a-z0-9]+$/.test(password)) return false;
  const letters = password.replace(/[^a-z]/g, '').length;
  return letters === 3 || letters === 4;
}

export class PasswordServiceImpl {
  private readonly random: (max: number) => number;

  constructor(private readonly deps: PasswordDeps) {
    if (Buffer.byteLength(deps.hmacSecret, 'utf8') < 32) {
      throw errors.invalidInput('Password fingerprint key must contain at least 32 bytes');
    }
    this.random = deps.randomInt ?? randomInt;
  }

  async generate(): Promise<string> {
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const letters = this.random(2) === 0 ? 4 : 3;
      const characters = Array.from({ length: 7 }, (_, index) =>
        index < letters
          ? String.fromCharCode(97 + this.random(26))
          : String(this.random(10)),
      );
      for (let index = characters.length - 1; index > 0; index -= 1) {
        const other = this.random(index + 1);
        [characters[index], characters[other]] = [characters[other]!, characters[index]!];
      }
      const password = characters.join('');
      const fingerprint = createHmac('sha256', this.deps.hmacSecret)
        .update(password, 'utf8').digest('hex');
      if (await this.deps.fingerprints.reserve(fingerprint)) return password;
    }
    throw errors.conflict('Unable to issue a unique password');
  }
}
