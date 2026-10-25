import { describe, expect, it } from 'vitest';
import {
  AuditEventId,
  AuditInput,
  AuditLogWriter,
  CourseId,
  GroupId,
  UserId,
} from '../../src/shared/contracts';
import {
  GroupCourse,
  GroupMembership,
  GroupRecord,
  GroupRepository,
  GroupService,
} from '../../src/domain/groups/service';

const gid = (value: string) => value as GroupId;
const uid = (value: string) => value as UserId;
const cid = (value: string) => value as CourseId;

class FakeGroupRepository implements GroupRepository {
  groups: GroupRecord[] = [];
  members: GroupMembership[] = [];
  courses: GroupCourse[] = [];
  private nextId = 0;

  async findGroupByCode(code: string): Promise<GroupRecord | null> {
    return this.groups.find((group) => group.code === code) ?? null;
  }

  async findGroupById(id: GroupId): Promise<GroupRecord | null> {
    return this.groups.find((group) => group.id === id) ?? null;
  }

  async createGroup(input: { code: string; name: string }): Promise<GroupRecord> {
    const group = { id: gid(`group-${++this.nextId}`), ...input };
    this.groups.push(group);
    return group;
  }

  async findMembership(groupId: GroupId, userId: UserId): Promise<GroupMembership | null> {
    return this.members.find((member) => member.groupId === groupId && member.userId === userId) ?? null;
  }

  async addMember(input: { groupId: GroupId; userId: UserId }): Promise<GroupMembership> {
    const member = { ...input };
    this.members.push(member);
    return member;
  }

  async removeMember(groupId: GroupId, userId: UserId): Promise<void> {
    this.members = this.members.filter((member) => !(member.groupId === groupId && member.userId === userId));
  }

  async findCourseAssignment(groupId: GroupId, courseId: CourseId): Promise<GroupCourse | null> {
    return this.courses.find((course) => course.groupId === groupId && course.courseId === courseId) ?? null;
  }

  async assignCourse(input: { groupId: GroupId; courseId: CourseId }): Promise<GroupCourse> {
    const assignment = { ...input };
    this.courses.push(assignment);
    return assignment;
  }
}

class RecordingAudit implements AuditLogWriter {
  calls: AuditInput[] = [];

  async append(input: AuditInput): Promise<AuditEventId> {
    this.calls.push(input);
    return 'audit-1' as AuditEventId;
  }
}

describe('GroupService', () => {
  it('creates groups and audits every mutation', async () => {
    const repository = new FakeGroupRepository();
    const audit = new RecordingAudit();
    const service = new GroupService({ repository, audit, actorId: uid('admin') });

    const group = await service.createGroup({ code: 'AI-1', name: 'Artificial Intelligence 1' });
    await service.addMember(group.id, uid('student'));
    await service.assignCourse(group.id, cid('course-1'));
    await service.removeMember(group.id, uid('student'));

    expect(repository.groups).toHaveLength(1);
    expect(audit.calls).toHaveLength(4);
    expect(audit.calls.map((call) => call.eventType)).toEqual([
      'group.created',
      'group.member_added',
      'group.course_assigned',
      'group.member_removed',
    ]);
    expect(audit.calls.every((call) => call.actorId === uid('admin'))).toBe(true);
  });

  it('enforces unique group codes and membership pairs', async () => {
    const repository = new FakeGroupRepository();
    const audit = new RecordingAudit();
    const service = new GroupService({ repository, audit });
    const group = await service.createGroup({ code: 'AI-1', name: 'First' });

    await expect(service.createGroup({ code: 'AI-1', name: 'Duplicate' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await service.addMember(group.id, uid('student'));
    await expect(service.addMember(group.id, uid('student'))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(audit.calls).toHaveLength(2);
  });

  it('requires an existing group for membership and course changes', async () => {
    const service = new GroupService({ repository: new FakeGroupRepository(), audit: new RecordingAudit() });

    await expect(service.addMember(gid('missing'), uid('student'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.assignCourse(gid('missing'), cid('course'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
