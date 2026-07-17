package handler

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// skillMentionFixture wires the seeded workspace-visible agent ("Handler Test
// Agent", J) to skillA and a second agent ("Handler Skill Other") to skillB so
// we can exercise the @skill mention path on the create-only
// triggerTasksForComment → bindAndEnqueueSkillMentions chain. The tests below
// lock in the explicit-designation contract:
//
//   - a designated agent is enqueued even when another agent holds the binding,
//     and is itself bound to the skill on submit
//   - a @skill mention with NO designation triggers nothing (silent), even when
//     an agent_skill binding exists
//   - a designated-but-unbound agent is bound then triggered
//   - an unavailable designated agent (archived) is skipped and does not abort
//     the other valid designations
//   - dedup prevents double-triggering against a pending task
//   - multiple @skill mentions each enqueue their own designated agent
//   - unknown / invalid skill IDs do not crash the comment handler
type skillMentionFixture struct {
	JID           string
	RuntimeID     string
	IssueID       string
	Issue         db.Issue
	CommentID     string
	Comment       db.Comment
	SkillID       string
	SecondSkillID string
	// OtherAgentID is a second handler-test agent used for the
	// "multiple skill mentions in one comment" scenario.
	OtherAgentID string
	OtherRuntime string
}

// newSkillMentionFixture creates one issue + a few skill bindings plus the
// extra agent the multi-skill test needs. Cleanup is wired through t.Cleanup
// so each sub-test gets a fresh fixture.
func newSkillMentionFixture(t *testing.T) skillMentionFixture {
	t.Helper()
	ctx := context.Background()

	// Load the seeded "Handler Test Agent" — same one the other mention
	// tests reuse, so we know it has a runtime and a workspace invocation
	// target (MUL-3963).
	var jID string
	if err := testPool.QueryRow(ctx, `
		SELECT id FROM agent WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1
	`, testWorkspaceID).Scan(&jID); err != nil {
		t.Fatalf("load seeded agent: %v", err)
	}
	var runtimeID string
	if err := testPool.QueryRow(ctx, `SELECT runtime_id FROM agent WHERE id = $1`, jID).Scan(&runtimeID); err != nil {
		t.Fatalf("load runtime: %v", err)
	}

	// Pick a per-workspace issue number so we don't collide with other
	// tests' fixtures.
	var number int
	if err := testPool.QueryRow(ctx, `
		UPDATE workspace
		SET issue_counter = GREATEST(issue_counter, (SELECT COALESCE(MAX(number), 0) FROM issue WHERE workspace_id = $1)) + 1
		WHERE id = $1 RETURNING issue_counter
	`, testWorkspaceID).Scan(&number); err != nil {
		t.Fatalf("next issue number: %v", err)
	}

	// The issue is unassigned so the implicit (assignee / reply-parent)
	// routing never fires and every queued task we observe comes from the
	// explicit skill designation under test.
	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, creator_type, creator_id, title, number)
		VALUES ($1, 'member', $2, $3, $4)
		RETURNING id
	`, testWorkspaceID, testUserID, "skill mention test", number).Scan(&issueID); err != nil {
		t.Fatalf("create issue: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
		testPool.Exec(context.Background(), `DELETE FROM comment WHERE issue_id = $1`, issueID)
		testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID)
	})

	skillA := insertHandlerTestSkill(t, "skill-mention-a", "skill A")
	skillB := insertHandlerTestSkill(t, "skill-mention-b", "skill B")

	// Bind skillA to the seeded agent J. Tests that assert "the designated
	// agent wins over the existing binding" designate a DIFFERENT agent and
	// confirm J's binding does not pull J in.
	if _, err := testPool.Exec(ctx, `
		INSERT INTO agent_skill (agent_id, skill_id) VALUES ($1, $2)
	`, jID, skillA); err != nil {
		t.Fatalf("bind skillA to J: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`, jID, skillA)
	})

	// Create a second agent for the multi-skill scenario. Skill B is bound
	// only to this other agent.
	otherAgentID := createHandlerTestAgent(t, "Handler Skill Other", nil)
	otherRuntime := handlerTestRuntimeID(t)
	if _, err := testPool.Exec(ctx, `
		INSERT INTO agent_skill (agent_id, skill_id) VALUES ($1, $2)
	`, otherAgentID, skillB); err != nil {
		t.Fatalf("bind skillB to other agent: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`, otherAgentID, skillB)
	})

	issue, err := testHandler.Queries.GetIssue(ctx, parseUUID(issueID))
	if err != nil {
		t.Fatalf("load issue: %v", err)
	}

	return skillMentionFixture{
		JID:           jID,
		RuntimeID:     runtimeID,
		IssueID:       issueID,
		Issue:         issue,
		SkillID:       skillA,
		SecondSkillID: skillB,
		OtherAgentID:  otherAgentID,
		OtherRuntime:  otherRuntime,
	}
}

// insertSkillMentionComment writes a comment whose content is the supplied
// mention text. The author is the seeded member (testUserID) — skill mentions
// from members are the user flow the feature targets.
func insertSkillMentionComment(t *testing.T, issueID, content string) string {
	t.Helper()
	var id string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO comment (workspace_id, issue_id, author_type, author_id, content)
		VALUES ($1, $2, 'member', $3, $4)
		RETURNING id
	`, testWorkspaceID, issueID, testUserID, content).Scan(&id); err != nil {
		t.Fatalf("insert skill mention comment: %v", err)
	}
	return id
}

// triggerSkillMentions drives the REAL create path — triggerTasksForComment —
// so these integration tests exercise the bind-and-trigger side effect (the
// durable agent_skill insert plus the enqueue), not the read-only compute path
// the preview uses. skillAgents is the parsed skill_mention_agents payload.
func triggerSkillMentions(t *testing.T, ctx context.Context, fx skillMentionFixture, commentID string, skillAgents map[string][]pgtype.UUID) []CommentTriggerOutcome {
	t.Helper()
	comment, err := testHandler.Queries.GetComment(ctx, parseUUID(commentID))
	if err != nil {
		t.Fatalf("load comment: %v", err)
	}
	// Zero-value parent / suppress list / originator: the fixture's author is a
	// member, so originator gating keys on the member id directly.
	return testHandler.triggerTasksForComment(ctx, fx.Issue, comment, nil, "member", testUserID, "", nil, skillAgents)
}

// countAgentSkillBindingsFor reports how many agent_skill rows link the agent to
// the skill — used to assert the bind-on-submit side effect.
func countAgentSkillBindingsFor(t *testing.T, agentID, skillID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `
		SELECT count(*) FROM agent_skill WHERE agent_id = $1 AND skill_id = $2
	`, agentID, skillID).Scan(&n); err != nil {
		t.Fatalf("count agent_skill bindings: %v", err)
	}
	return n
}

// TestEnqueueSkillMention_UsesFrontendResolvedAgent proves the explicit-
// designation happy path: the frontend designates "other" (not J, even though J
// holds the agent_skill binding), and the backend enqueues exactly "other".
// Because "other" was NOT bound to skillA, the create path must also bind it.
func TestEnqueueSkillMention_UsesFrontendResolvedAgent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillA](mention://skill/"+fx.SkillID+") please review")

	// "other" starts unbound to skillA.
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 0 {
		t.Fatalf("precondition: expected other agent unbound to skillA, got %d bindings", got)
	}

	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		fx.SkillID: {parseUUIDForTest(t, fx.OtherAgentID)},
	})

	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected 1 queued task on designated agent, got %d", got)
	}
	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on agent_skill binding (designation overrode it), got %d", got)
	}
	// Bind-on-submit: the designated agent must now be bound to skillA.
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected designated agent bound to skillA after submit, got %d bindings", got)
	}
}

// TestEnqueueSkillMention_NoDesignationIsSilent reverses the old fallback: a
// @skill mention with NO skill_mention_agents entry now enqueues NOTHING, even
// though J holds an agent_skill binding. The backend never reverse-looks-up the
// junction table to pick a target.
func TestEnqueueSkillMention_NoDesignationIsSilent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillA](mention://skill/"+fx.SkillID+") please review")

	triggerSkillMentions(t, ctx, fx, commentID, nil)

	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks with no designation (binding must not be consulted), got %d", got)
	}
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks with no designation, got %d", got)
	}
}

// TestEnqueueSkillMention_NoDesignationIgnoresAssignee confirms R13 is gone:
// without a designation, a @skill mention fires nothing regardless of who the
// issue assignee is or what skills they hold.
func TestEnqueueSkillMention_NoDesignationIgnoresAssignee(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// Make J (which holds skillA) the issue assignee.
	if _, err := testPool.Exec(ctx, `
		UPDATE issue SET assignee_type = 'agent', assignee_id = $1 WHERE id = $2
	`, fx.JID, fx.IssueID); err != nil {
		t.Fatalf("assign issue to J: %v", err)
	}
	fx.Issue, _ = testHandler.Queries.GetIssue(ctx, parseUUID(fx.IssueID))

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillA](mention://skill/"+fx.SkillID+") please review")

	triggerSkillMentions(t, ctx, fx, commentID, nil)

	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks with no designation even for the assignee, got %d", got)
	}
}

// TestEnqueueSkillMention_DedupesAgainstPendingTask locks in that the
// hasPendingTaskForIssueAndAgent dedupe applies to the skill designation path
// just like it does for @agent / @squad mentions. A queued task must block a
// second queued task for the same (issue, agent).
func TestEnqueueSkillMention_DedupesAgainstPendingTask(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// Seed a queued task on J — simulates a previous mention that already
	// enqueued against this issue.
	if _, err := testPool.Exec(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status)
		VALUES ($1, $2, $3, 'queued')
	`, fx.JID, fx.RuntimeID, fx.IssueID); err != nil {
		t.Fatalf("seed queued task: %v", err)
	}

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillA](mention://skill/"+fx.SkillID+") please review")

	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		fx.SkillID: {parseUUIDForTest(t, fx.JID)},
	})

	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 1 {
		t.Fatalf("expected dedupe (still 1 queued task), got %d", got)
	}
}

// TestEnqueueSkillMention_MultipleSkillMentionsIndependent verifies that two
// @skill mentions in one comment each enqueue their own designated agent — one
// queued task per distinct agent, no merging across skills.
func TestEnqueueSkillMention_MultipleSkillMentionsIndependent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	content := "[@SkillA](mention://skill/" + fx.SkillID + ") and " +
		"[@SkillB](mention://skill/" + fx.SecondSkillID + ") please review"
	commentID := insertSkillMentionComment(t, fx.IssueID, content)

	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		fx.SkillID:       {parseUUIDForTest(t, fx.JID)},
		fx.SecondSkillID: {parseUUIDForTest(t, fx.OtherAgentID)},
	})

	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 1 {
		t.Fatalf("expected 1 queued task on J (skill A designation), got %d", got)
	}
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected 1 queued task on other (skill B designation), got %d", got)
	}
}

// TestEnqueueSkillMention_UnknownSkillIDIsNoCrash confirms the failure
// contract: a mention whose skill ID does not exist in this workspace must not
// abort the trigger computation, must not enqueue a task, and must not bind
// anything — even if the (bogus) mention carries a designation.
func TestEnqueueSkillMention_UnknownSkillIDIsNoCrash(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	bogusID := "00000000-0000-0000-0000-000000000000"
	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@Unknown](mention://skill/"+bogusID+")")

	// Must not panic, even with a designation pointing at a real agent.
	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		bogusID: {parseUUIDForTest(t, fx.JID)},
	})

	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on bogus skill, got %d", got)
	}
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on bogus skill, got %d", got)
	}
	if got := countAgentSkillBindingsFor(t, fx.JID, bogusID); got != 0 {
		t.Fatalf("expected no binding written for bogus skill, got %d", got)
	}
}

// TestEnqueueSkillMention_UnboundSkillBindsAndTriggers reverses the old
// "unbound skill silently dropped" case: a designated-but-unbound agent is now
// BOUND (new agent_skill row) then TRIGGERED.
func TestEnqueueSkillMention_UnboundSkillBindsAndTriggers(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// Skill C is created but never bound to any agent.
	skillC := insertHandlerTestSkill(t, "skill-mention-c", "no bindings")

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillC](mention://skill/"+skillC+")")

	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		skillC: {parseUUIDForTest(t, fx.OtherAgentID)},
	})

	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected 1 queued task on designated (previously unbound) agent, got %d", got)
	}
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, skillC); got != 1 {
		t.Fatalf("expected designated agent bound to skillC, got %d bindings", got)
	}
	// Cleanup the binding this test created via the create path.
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`,
			fx.OtherAgentID, skillC)
	})
}

// TestEnqueueSkillMention_SkillWithNoDesignationNoBindingsIsSilent covers the
// remaining silent case: a real skill with neither a designation nor any
// binding produces no task.
func TestEnqueueSkillMention_SkillWithNoDesignationNoBindingsIsSilent(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	skillC := insertHandlerTestSkill(t, "skill-mention-c", "no bindings")

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillC](mention://skill/"+skillC+")")

	triggerSkillMentions(t, ctx, fx, commentID, nil)

	if got := countQueuedOrDispatched(t, fx.JID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on undesigned/unbound skill, got %d on J", got)
	}
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on undesigned/unbound skill, got %d on other", got)
	}
}

// TestEnqueueSkillMention_UnavailableAgentSkippedOthersSurvive designates both
// an archived agent and a healthy agent for the same skill: the archived one is
// skipped (no task, no binding) and does NOT abort the healthy designation.
func TestEnqueueSkillMention_UnavailableAgentSkippedOthersSurvive(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	// A third agent that we then archive so it is unavailable.
	archivedAgentID := createHandlerTestAgent(t, "Handler Skill Archived", nil)
	if _, err := testPool.Exec(ctx, `
		UPDATE agent SET archived_at = now() WHERE id = $1
	`, archivedAgentID); err != nil {
		t.Fatalf("archive agent: %v", err)
	}

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillA](mention://skill/"+fx.SkillID+") please review")

	triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		fx.SkillID: {
			parseUUIDForTest(t, archivedAgentID),
			parseUUIDForTest(t, fx.OtherAgentID),
		},
	})

	// Archived agent: no task, no binding.
	if got := countQueuedOrDispatched(t, archivedAgentID, fx.IssueID); got != 0 {
		t.Fatalf("expected 0 queued tasks on archived agent, got %d", got)
	}
	if got := countAgentSkillBindingsFor(t, archivedAgentID, fx.SkillID); got != 0 {
		t.Fatalf("expected archived agent NOT bound, got %d bindings", got)
	}
	// Healthy designated agent still fires and is bound.
	if got := countQueuedOrDispatched(t, fx.OtherAgentID, fx.IssueID); got != 1 {
		t.Fatalf("expected 1 queued task on healthy designated agent, got %d", got)
	}
	if got := countAgentSkillBindingsFor(t, fx.OtherAgentID, fx.SkillID); got != 1 {
		t.Fatalf("expected healthy designated agent bound, got %d bindings", got)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`,
			fx.OtherAgentID, fx.SkillID)
	})
}

// TestEnqueueSkillMention_EnqueuedOutcomeSurfaces checks the returned outcome:
// a designated agent that enqueues appears as a queued "agent" outcome, and an
// unavailable designation surfaces as blocked with a target_unavailable reason.
func TestEnqueueSkillMention_EnqueuedOutcomeSurfaces(t *testing.T) {
	if testHandler == nil || testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	fx := newSkillMentionFixture(t)

	archivedAgentID := createHandlerTestAgent(t, "Handler Skill Archived", nil)
	if _, err := testPool.Exec(ctx, `
		UPDATE agent SET archived_at = now() WHERE id = $1
	`, archivedAgentID); err != nil {
		t.Fatalf("archive agent: %v", err)
	}

	commentID := insertSkillMentionComment(t, fx.IssueID,
		"[@SkillA](mention://skill/"+fx.SkillID+") please review")

	outcomes := triggerSkillMentions(t, ctx, fx, commentID, map[string][]pgtype.UUID{
		fx.SkillID: {
			parseUUIDForTest(t, fx.OtherAgentID),
			parseUUIDForTest(t, archivedAgentID),
		},
	})

	var healthy, archived *CommentTriggerOutcome
	for i := range outcomes {
		o := outcomes[i]
		switch o.TargetID {
		case fx.OtherAgentID:
			healthy = &o
		case archivedAgentID:
			archived = &o
		}
	}
	if healthy == nil {
		t.Fatalf("expected an outcome for the healthy designated agent, got %+v", outcomes)
	}
	if healthy.TargetType != "agent" || healthy.Status != DispatchQueued {
		t.Fatalf("expected healthy designated agent queued, got %+v", *healthy)
	}
	if archived == nil {
		t.Fatalf("expected an outcome for the archived designated agent, got %+v", outcomes)
	}
	if archived.Status != DispatchBlocked || archived.ReasonCode != ReasonTargetUnavailable {
		t.Fatalf("expected archived designated agent blocked/target_unavailable, got %+v", *archived)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`DELETE FROM agent_skill WHERE agent_id = $1 AND skill_id = $2`,
			fx.OtherAgentID, fx.SkillID)
	})
}

// parseUUIDForTest wraps parseUUID so the test file does not have to import
// the util package directly for a single call site.
func parseUUIDForTest(t *testing.T, s string) pgtype.UUID {
	t.Helper()
	u := parseUUID(s)
	if !u.Valid {
		t.Fatalf("parseUUIDForTest(%q): invalid uuid", s)
	}
	return u
}
