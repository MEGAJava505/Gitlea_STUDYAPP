/**
 * Port for Gitea's Git-submission operations.
 *
 * Every Gitea call used by the assignment state machine is behind this
 * interface so the domain can be unit-tested with an in-memory fake and never
 * touches a live Gitea service or its admin token directly.
 */
export interface GiteaSubmissionPort {
  /** True when the commit exists on the remote repository. */
  hasCommit(input: { repoFullName: string; commitSha: string }): Promise<boolean>;

  /** Creates the immutable `submission/<attempt>` snapshot for a commit. */
  createProtectedSnapshot(input: {
    repoFullName: string;
    commitSha: string;
    attempt: number;
  }): Promise<{ protectedRef: string }>;

  /**
   * Ensures exactly one open review Pull Request from the snapshot branch to
   * the repository's default (original assignment) branch. Idempotent.
   */
  ensureReviewPullRequest(input: {
    repoFullName: string;
    protectedRef: string;
    attempt: number;
  }): Promise<{ number: number }>;

  /**
   * Returns a previously created snapshot for the given attempt, if one exists.
   * Used to reconcile a network retry after a partially committed submit.
   */
  getExistingSubmission(input: {
    repoFullName: string;
    attempt: number;
  }): Promise<{ protectedRef: string; commitSha: string } | null>;
}
