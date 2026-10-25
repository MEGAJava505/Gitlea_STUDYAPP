import {
  AuditEvent,
  AuditEventId,
  AuditInput,
  AuditLogWriter,
  AuditRepository,
  Clock,
} from '../shared/contracts';

const REDACTED = '[REDACTED]';

const SENSITIVE_KEY = /token|password|secret|credential|cookie|authorization|api[_-]?key|private[_-]?key|access[_-]?key/i;

interface AuditDeps {
  audit: AuditRepository;
  now: Clock;
  newId?: () => AuditEventId;
}

/**
 * Appends a structured audit event through the injected repository and returns
 * its ID. Payloads are redacted recursively so session tokens, passwords and
 * Gitea credentials can never reach the log. Any repository failure is
 * propagated to the caller so a protected operation cannot be reported as
 * successful when its audit trail was not written.
 */
export class AuditLogWriterImpl implements AuditLogWriter {
  private readonly audit: AuditRepository;
  private readonly now: Clock;
  private readonly newId: () => AuditEventId;

  constructor(deps: AuditDeps) {
    this.audit = deps.audit;
    this.now = deps.now;
    this.newId = deps.newId ?? defaultId;
  }

  async append(input: AuditInput): Promise<AuditEventId> {
    const event: AuditEvent = {
      id: this.newId(),
      actorId: input.actorId,
      eventType: input.eventType,
      targetType: input.targetType,
      targetId: input.targetId,
      payload: redact(input.payload),
      createdAt: this.now(),
    };
    return this.audit.append(event);
  }
}

/** Deep redaction of secret-like fields. Never returns the original object. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v);
    }
    return out;
  }
  return value;
}

let counter = 0;
function defaultId(): AuditEventId {
  counter += 1;
  return `audit-${Date.now().toString(36)}-${counter.toString(36)}` as AuditEventId;
}
