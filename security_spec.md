# Security Specification: Genius Emailer

## 1. Data Invariants
1. **UserProfile Invariants**: A user profile path `/users/{userId}` can only be read or written by the authenticated user whose `uid` matches `{userId}`.
2. **SmtpNode Invariants**: Users may only read, create, update, or delete SMTP relay servers inside their own path `/users/{userId}/smtp_nodes/{nodeId}`. `ownerId` must match the authenticated user.
3. **EmailJob Invariants**: Users may only read or update email jobs they own, located under `/users/{userId}/jobs/{jobId}`.

## 2. The "Dirty Dozen" Malicious Payloads (Unauthorized Transitions)
1. **Identity Spoofing in profile creation**: An attacker attempts to write a user profile with high-privilege flags or a mocked email to `/users/attackerId` with custom fields. (Blocked by schema matching and uid validation).
2. **Accessing other people's SMTP credentials**: User A attempts to read `/users/userB/smtp_nodes/node1`. (Blocked by path variable checks).
3. **Poisoning database with extreme string lengths**: A user attempts to create a job with a 50MB string body or logs. (Blocked by `.size()` limit validation on properties).
4. **Altering read-only immutable fields on campaign jobs**: A user tries to update the `createdAt` or `total` fields after a job starts. (Blocked by immutability rules: `incoming().createdAt == existing().createdAt`).
5. **State Shortcut**: User attempts to force-transition status of job from ready straight to completed without sending any emails. (Blocked by schema state constraints).
6. **Setting someone else's UID as Campaign Owner**: User A submits a job to `/users/userA/jobs/job1` but sets `ownerId: "userB"`. (Blocked by `isValidEmailJob` verifying `incoming().ownerId == request.auth.uid`).
7. **Junk SMTP ID Poisoning**: A user submits an SMTP node with characters containing nested paths or malicious scripts in the document ID (e.g., `../poison`). (Blocked by `isValidId(nodeId)` regex check).
8. **Bypassing Verification**: An unverified email user attempts to trigger/register campaign jobs. (Blocked by requiring `request.auth.token.email_verified == true`).
9. **Recursive Cost-Attack**: Attempting list queries over collections without specifying security boundaries. (Blocked by path matching requiring `request.auth.uid`).
10. **Shadow Key Insertion**: Attempting to insert extra undocumented fields (e.g., `isAdmin: true`) when creating `UserProfile`. (Blocked by `hasAll` and exact size validation).
11. **Malicious Email Domain Spoof**: Attempting to alter smtp relay host to inject command line interfaces. (Blocked by strict string matching and host patterns).
12. **Zombie Update**: Trying to edit a `completed` job to set status back to `paused` to restart sending processes. (Blocked by status transition validations).

## 3. Recommended Security Rules draft (`DRAFT_firestore.rules`)
See `firestore.rules` for full detailed rule coverage.
