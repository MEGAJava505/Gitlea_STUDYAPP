import {
  AuditInput,
  AuditLogWriter,
  CourseId,
  GroupId,
  UserId,
  errors,
} from '../../shared/contracts';

export interface GroupRecord {
  id: GroupId;
  code: string;
  name: string;
}

export interface GroupMembership {
  groupId: GroupId;
  userId: UserId;
}

export interface GroupCourse {
  groupId: GroupId;
  courseId: CourseId;
}

export interface GroupRepository {
  findGroupByCode(code: string): Promise<GroupRecord | null>;
  findGroupById(id: GroupId): Promise<GroupRecord | null>;
  createGroup(input: { code: string; name: string }): Promise<GroupRecord>;
  findMembership(groupId: GroupId, userId: UserId): Promise<GroupMembership | null>;
  addMember(input: { groupId: GroupId; userId: UserId }): Promise<GroupMembership>;
  removeMember(groupId: GroupId, userId: UserId): Promise<void>;
  findCourseAssignment(groupId: GroupId, courseId: CourseId): Promise<GroupCourse | null>;
  assignCourse(input: { groupId: GroupId; courseId: CourseId }): Promise<GroupCourse>;
}

export interface GroupServiceDependencies {
  repository: GroupRepository;
  audit: AuditLogWriter;
  actorId?: UserId | null;
}

export class GroupService {
  private readonly repository: GroupRepository;
  private readonly audit: AuditLogWriter;
  private readonly actorId: UserId | null;

  constructor(dependencies: GroupServiceDependencies) {
    this.repository = dependencies.repository;
    this.audit = dependencies.audit;
    this.actorId = dependencies.actorId ?? null;
  }

  async createGroup(input: { code: string; name: string }): Promise<GroupRecord> {
    const code = input.code.trim();
    const name = input.name.trim();
    if (!code || !name) throw errors.invalidInput('Group code and name are required');
    if (await this.repository.findGroupByCode(code)) throw errors.conflict(`Group code "${code}" already exists`);
    const group = await this.repository.createGroup({ code, name });
    await this.writeAudit('group.created', group.id, { code: group.code, name: group.name });
    return group;
  }

  async addMember(groupId: GroupId, userId: UserId): Promise<GroupMembership> {
    await this.requireGroup(groupId);
    if (await this.repository.findMembership(groupId, userId)) throw errors.conflict('User is already a member of this group');
    const membership = await this.repository.addMember({ groupId, userId });
    await this.writeAudit('group.member_added', groupId, { userId });
    return membership;
  }

  async removeMember(groupId: GroupId, userId: UserId): Promise<void> {
    await this.requireGroup(groupId);
    if (!(await this.repository.findMembership(groupId, userId))) throw errors.notFound('group membership');
    await this.repository.removeMember(groupId, userId);
    await this.writeAudit('group.member_removed', groupId, { userId });
  }

  async assignCourse(groupId: GroupId, courseId: CourseId): Promise<GroupCourse> {
    await this.requireGroup(groupId);
    if (await this.repository.findCourseAssignment(groupId, courseId)) throw errors.conflict('Course is already assigned to this group');
    const assignment = await this.repository.assignCourse({ groupId, courseId });
    await this.writeAudit('group.course_assigned', groupId, { courseId });
    return assignment;
  }

  private async requireGroup(groupId: GroupId): Promise<GroupRecord> {
    const group = await this.repository.findGroupById(groupId);
    if (!group) throw errors.notFound('group');
    return group;
  }

  private async writeAudit(eventType: GroupAuditEventType, targetId: string, payload: Record<string, unknown>): Promise<void> {
    const input: AuditInput = {
      actorId: this.actorId,
      eventType,
      targetType: 'group',
      targetId,
      payload,
    };
    await this.audit.append(input);
  }
}

export type GroupAuditEventType = 'group.created' | 'group.member_added' | 'group.member_removed' | 'group.course_assigned';
export const GroupServiceImpl = GroupService;
