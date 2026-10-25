import { relations } from 'drizzle-orm';
import {
  activations, auditEvents, compensationWindows, courseAssignments, courseGroups, courses,
  groupAssignments, groupMembers, groups, lessonPublications, lessons, notificationPreferences,
  notifications, outageIncidents, repositoryLinks, reviews, studentProfiles, submissions,
  testDefinitions, testRuns, userRoles, users,
} from './schema';

export const usersRelations = relations(users, ({ one, many }) => ({
  roles: many(userRoles),
  studentProfile: one(studentProfiles),
  groupMembers: many(groupMembers),
  ownedCourses: many(courses),
  reviews: many(reviews),
  notifications: many(notifications),
  notificationPreferences: many(notificationPreferences),
  auditEvents: many(auditEvents),
  repositories: many(repositoryLinks),
}));
export const userRolesRelations = relations(userRoles, ({ one }) => ({ user: one(users, { fields: [userRoles.userId], references: [users.id] }) }));
export const studentProfilesRelations = relations(studentProfiles, ({ one, many }) => ({ user: one(users, { fields: [studentProfiles.userId], references: [users.id] }), activations: many(activations) }));
export const activationsRelations = relations(activations, ({ one }) => ({ studentProfile: one(studentProfiles, { fields: [activations.studentProfileId], references: [studentProfiles.id] }) }));
export const groupsRelations = relations(groups, ({ many }) => ({ members: many(groupMembers), courses: many(courseGroups), lessons: many(lessonPublications), assignments: many(groupAssignments) }));
export const groupMembersRelations = relations(groupMembers, ({ one }) => ({ group: one(groups, { fields: [groupMembers.groupId], references: [groups.id] }), user: one(users, { fields: [groupMembers.userId], references: [users.id] }) }));
export const coursesRelations = relations(courses, ({ one, many }) => ({ owner: one(users, { fields: [courses.ownerId], references: [users.id] }), groups: many(courseGroups), lessons: many(lessons), assignments: many(courseAssignments) }));
export const courseGroupsRelations = relations(courseGroups, ({ one }) => ({ course: one(courses, { fields: [courseGroups.courseId], references: [courses.id] }), group: one(groups, { fields: [courseGroups.groupId], references: [groups.id] }) }));
export const lessonsRelations = relations(lessons, ({ one, many }) => ({ course: one(courses, { fields: [lessons.courseId], references: [courses.id] }), publications: many(lessonPublications) }));
export const lessonPublicationsRelations = relations(lessonPublications, ({ one }) => ({ lesson: one(lessons, { fields: [lessonPublications.lessonId], references: [lessons.id] }), group: one(groups, { fields: [lessonPublications.groupId], references: [groups.id] }) }));
export const courseAssignmentsRelations = relations(courseAssignments, ({ one, many }) => ({ course: one(courses, { fields: [courseAssignments.courseId], references: [courses.id] }), author: one(users, { fields: [courseAssignments.authorId], references: [users.id] }), groups: many(groupAssignments) }));
export const groupAssignmentsRelations = relations(groupAssignments, ({ one, many }) => ({ courseAssignment: one(courseAssignments, { fields: [groupAssignments.courseAssignmentId], references: [courseAssignments.id] }), group: one(groups, { fields: [groupAssignments.groupId], references: [groups.id] }), repositories: many(repositoryLinks), tests: many(testDefinitions) }));
export const repositoryLinksRelations = relations(repositoryLinks, ({ one, many }) => ({ assignment: one(groupAssignments, { fields: [repositoryLinks.groupAssignmentId], references: [groupAssignments.id] }), student: one(users, { fields: [repositoryLinks.studentId], references: [users.id] }), submissions: many(submissions) }));
export const submissionsRelations = relations(submissions, ({ one, many }) => ({ repository: one(repositoryLinks, { fields: [submissions.repositoryLinkId], references: [repositoryLinks.id] }), reviews: many(reviews), testRuns: many(testRuns) }));
export const reviewsRelations = relations(reviews, ({ one }) => ({ submission: one(submissions, { fields: [reviews.submissionId], references: [submissions.id] }), reviewer: one(users, { fields: [reviews.reviewerId], references: [users.id] }) }));
export const testDefinitionsRelations = relations(testDefinitions, ({ one, many }) => ({ assignment: one(groupAssignments, { fields: [testDefinitions.groupAssignmentId], references: [groupAssignments.id] }), runs: many(testRuns) }));
export const testRunsRelations = relations(testRuns, ({ one }) => ({ definition: one(testDefinitions, { fields: [testRuns.testDefinitionId], references: [testDefinitions.id] }), submission: one(submissions, { fields: [testRuns.submissionId], references: [submissions.id] }) }));
export const notificationsRelations = relations(notifications, ({ one }) => ({ recipient: one(users, { fields: [notifications.recipientId], references: [users.id] }) }));
export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({ user: one(users, { fields: [notificationPreferences.userId], references: [users.id] }) }));
export const outageIncidentsRelations = relations(outageIncidents, ({ many }) => ({ compensationWindows: many(compensationWindows) }));
export const compensationWindowsRelations = relations(compensationWindows, ({ one }) => ({ incident: one(outageIncidents, { fields: [compensationWindows.outageIncidentId], references: [outageIncidents.id] }) }));
export const auditEventsRelations = relations(auditEvents, ({ one }) => ({ actor: one(users, { fields: [auditEvents.actorId], references: [users.id] }) }));
