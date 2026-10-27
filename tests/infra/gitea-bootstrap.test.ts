import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const compose = readFileSync(resolve(process.cwd(), 'docker-compose.yml'), 'utf8');
const giteaService = compose.slice(compose.indexOf('  gitea:\n'), compose.indexOf('  # ---------------------------------------------------------------------------\n  # proxy'));

describe('Gitea bootstrap contract', () => {
  it('runs through the upstream entrypoint before the headless bootstrap', () => {
    expect(giteaService).toContain('      - /usr/bin/entrypoint\n');
    expect(giteaService).toContain('      - /bin/sh\n');
    expect(giteaService).toContain('app.ini.template:ro');
    expect(giteaService).toContain('chown git:git /data/gitea /data/gitea/conf /data/gitea/log /data/git');
    expect(giteaService).toContain('/data/git/.ssh');
    expect(giteaService).not.toContain('GITEA__oauth2__JWT_SECRET');
    expect(giteaService).not.toMatch(/chown\s+-R/);
  });
});
