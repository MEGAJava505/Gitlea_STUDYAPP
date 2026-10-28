import { and, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { randomUUID } from 'node:crypto';
import { redact } from '../domain/audit';
import {
  type AssignmentRepository,
  type AuditInput,
  type AssignmentView,
  type AssignmentId,
  type NewReview,
  type NewSubmission,
  type RepositoryLinkId,
  type RepositoryLinkRecord,
  type ReviewRecord,
  type SubmissionId,
  type SubmissionRecord,
  type UserId,
} from '../shared/contracts';
import {
  auditEvents,
  courseAssignments,
  groupAssignments,
  repositoryLinks,
  reviews,
  submissions,
} from '../db/schema';
import * as relations from '../db/relations';

type Db = BetterSQLite3Database<typeof relations>;

/**
 * SQLite-backed AssignmentRepository (drizzle). Satisfies the domain port used
 * by the assignment state machine and the permission checker so the production
 * service container can wire the real database.
 */
export class DbAssignmentRepository implements AssignmentRepository {
  constructor(private readonly db: Db) {}

  async getAssignment(id: AssignmentId): Promise<AssignmentView | null> {
    const rows = this.db
      .select({
        id: groupAssignments.id,
        courseAssignmentId: groupAssignments.courseAssignmentId,
        authorId: courseAssignments.authorId,
        groupId: groupAssignments.groupId,
        deadline: groupAssignments.deadline,
        allowResubmission: courseAssignments.allowResubmission,
        publishedAt: groupAssignments.publishedAt,
      })
      .from(groupAssignments)
      .innerJoin(courseAssignments, eq(groupAssignments.courseAssignmentId, courseAssignments.id))
      .where(eq(groupAssignments.id, id))
      .all();
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id as AssignmentId,
      courseAssignmentId: row.courseAssignmentId,
      teacherId: row.authorId as UserId,
      groupId: row.groupId as AssignmentView['groupId'],
      deadline: row.deadline ?? 0,
      resubmissionPolicy: row.allowResubmission ? 'allowed' : 'forbidden',
      publishedAt: row.publishedAt ?? 0,
    };
  }

  async getRepositoryLink(assignmentId: AssignmentId, studentId: UserId): Promise<RepositoryLinkRecord | null> {
    const row = this.db
      .select()
      .from(repositoryLinks)
      .where(and(eq(repositoryLinks.groupAssignmentId, assignmentId), eq(repositoryLinks.studentId, studentId)))
      .get();
    return row ? toLinkRecord(row) : null;
  }

  async getRepositoryLinkById(id: RepositoryLinkId): Promise<RepositoryLinkRecord | null> {
    const row = this.db.select().from(repositoryLinks).where(eq(repositoryLinks.id, id)).get();
    return row ? toLinkRecord(row) : null;
  }

  async listSubmissions(linkId: RepositoryLinkId): Promise<SubmissionRecord[]> {
    return this.db
      .select()
      .from(submissions)
      .where(eq(submissions.repositoryLinkId, linkId))
      .all()
      .map(toSubmissionRecord);
  }

  async getSubmissionByIdempotencyKey(linkId: RepositoryLinkId, key: string): Promise<SubmissionRecord | null> {
    const row = this.db
      .select()
      .from(submissions)
      .where(and(eq(submissions.repositoryLinkId, linkId), eq(submissions.idempotencyKey, key)))
      .get();
    return row ? toSubmissionRecord(row) : null;
  }

  async getSubmission(id: SubmissionId): Promise<SubmissionRecord | null> {
    const row = this.db.select().from(submissions).where(eq(submissions.id, id)).get();
    return row ? toSubmissionRecord(row) : null;
  }

  async insertSubmission(input: NewSubmission): Promise<SubmissionRecord> {
    return this.persistSubmission(input);
  }

  async insertSubmissionWithAudit(input: NewSubmission, audit: Omit<AuditInput, 'targetId'>): Promise<SubmissionRecord> {
    return this.persistSubmission(input, audit);
  }

  private persistSubmission(input: NewSubmission, audit?: Omit<AuditInput, 'targetId'>): SubmissionRecord {
    const id = randomUUID() as SubmissionId;
    this.db.transaction((tx) => {
      tx
        .insert(submissions)
        .values({
          id,
          repositoryLinkId: input.repositoryLinkId,
          attempt: input.attempt,
          commitSha: input.commitSha,
          protectedRef: input.protectedRef,
          status: input.status,
          submittedAt: input.submittedAt,
          idempotencyKey: input.idempotencyKey,
        })
        .run();
      // Keep the repository link's denormalised status in sync with the latest submission.
      tx
        .update(repositoryLinks)
        .set({ status: input.status })
        .where(eq(repositoryLinks.id, input.repositoryLinkId))
        .run();
      // Synchronous SQL on this exact transaction handle: any audit failure
      // rolls back both writes above, including immutable submission rows.
      if (audit) {
        tx.insert(auditEvents).values({
          id: randomUUID(),
          actorId: audit.actorId,
          eventType: audit.eventType,
          targetType: audit.targetType,
          targetId: id,
          payload: redact(audit.payload) as Record<string, unknown>,
          occurredAt: Date.now(),
        }).run();
      }
    });
    return {
      id,
      repositoryLinkId: input.repositoryLinkId,
      attempt: input.attempt,
      commitSha: input.commitSha,
      protectedRef: input.protectedRef,
      status: input.status,
      submittedAt: input.submittedAt,
      idempotencyKey: input.idempotencyKey,
    };
  }

  async updateSubmissionStatus(id: SubmissionId, status: SubmissionRecord['status']): Promise<void> {
    this.db.transaction((tx) => {
      const submission = tx.select().from(submissions).where(eq(submissions.id, id)).get();
      if (!submission) return;
      tx.update(submissions).set({ status }).where(eq(submissions.id, id)).run();
      const latest = tx.select({ id: submissions.id }).from(submissions)
        .where(eq(submissions.repositoryLinkId, submission.repositoryLinkId))
        .orderBy(desc(submissions.attempt)).get();
      if (latest?.id === id) {
        tx.update(repositoryLinks).set({ status })
          .where(eq(repositoryLinks.id, submission.repositoryLinkId)).run();
      }
    });
  }

  async insertReview(input: NewReview): Promise<ReviewRecord> {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .insert(reviews)
      .values({
        id,
        submissionId: input.submissionId,
        reviewerId: input.reviewerId,
        decision: input.decision === 'pass' ? 'passed' : 'failed',
        feedback: input.feedback,
        grade: input.grade,
        isActive: true,
      })
      .run();
    return {
      id: id as ReviewRecord['id'],
      submissionId: input.submissionId,
      reviewerId: input.reviewerId,
      decision: input.decision,
      feedback: input.feedback,
      grade: input.grade,
      createdAt: now,
    };
  }
}

export function toLinkRecord(row: typeof repositoryLinks.$inferSelect): RepositoryLinkRecord {
  return {
    id: row.id as RepositoryLinkId,
    groupAssignmentId: row.groupAssignmentId as AssignmentId,
    studentId: row.studentId as UserId,
    giteaRepoFullName: row.fullName,
    giteaRepoId: row.giteaRepositoryId,
    isPrivate: row.isPrivate,
  };
}

function toSubmissionRecord(row: typeof submissions.$inferSelect): SubmissionRecord {
  return {
    id: row.id as SubmissionId,
    repositoryLinkId: row.repositoryLinkId as RepositoryLinkId,
    attempt: row.attempt,
    commitSha: row.commitSha,
    protectedRef: row.protectedRef,
    status: row.status,
    submittedAt: row.submittedAt,
    idempotencyKey: row.idempotencyKey,
  };
}
