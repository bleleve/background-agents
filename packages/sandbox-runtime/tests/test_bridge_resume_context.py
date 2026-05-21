"""Tests for the resume-context preamble in bridge prompt handling.

When the control plane attaches `resumeContext.currentPlan`, the bridge should
prepend a restate-and-confirm preamble to the prompt sent to OpenCode so the
agent re-anchors on the saved plan before any destructive action.
"""

from sandbox_runtime.bridge import AgentBridge


class TestResumePreamble:
    def test_returns_none_when_no_resume_context(self):
        assert AgentBridge._build_resume_preamble({}) is None

    def test_returns_none_when_current_plan_missing(self):
        assert AgentBridge._build_resume_preamble({"currentPlan": None}) is None

    def test_returns_none_for_empty_plan_content(self):
        assert (
            AgentBridge._build_resume_preamble({"currentPlan": {"content": "   ", "version": 1}})
            is None
        )

    def test_returns_none_for_non_string_content(self):
        assert (
            AgentBridge._build_resume_preamble({"currentPlan": {"content": 42, "version": 1}})
            is None
        )

    def test_preamble_includes_version_and_plan_body(self):
        preamble = AgentBridge._build_resume_preamble(
            {"currentPlan": {"version": 7, "content": "## Plan\n- step A\n- step B"}}
        )
        assert preamble is not None
        assert "version 7" in preamble
        assert "## Plan" in preamble
        assert "step A" in preamble
        assert "Wait for explicit confirmation" in preamble
        # The preamble must end with a marker that separates it from the new
        # instruction body — otherwise the agent could conflate the two.
        assert preamble.endswith("## New instruction\n\n")

    def test_preamble_falls_back_to_question_mark_when_version_missing(self):
        preamble = AgentBridge._build_resume_preamble({"currentPlan": {"content": "body"}})
        assert preamble is not None
        assert "version ?" in preamble


class TestPlanningPreamble:
    def test_planning_preamble_without_previous_plan(self):
        preamble = AgentBridge._build_planning_preamble({})
        assert preamble.startswith("## Planning turn")
        assert "Do not edit files" in preamble
        assert "Previous plan" not in preamble
        assert preamble.endswith("## User instruction\n\n")

    def test_planning_preamble_includes_previous_plan_when_present(self):
        preamble = AgentBridge._build_planning_preamble(
            {"currentPlan": {"version": 3, "content": "## v3 plan\n- step A"}}
        )
        assert "Previous plan (version 3)" in preamble
        assert "step A" in preamble
        assert "Amend it based on the new user instruction" in preamble
        assert preamble.endswith("## User instruction\n\n")

    def test_planning_preamble_ignores_empty_previous_plan(self):
        preamble = AgentBridge._build_planning_preamble(
            {"currentPlan": {"version": 1, "content": "   "}}
        )
        assert "Previous plan" not in preamble

    def test_planning_preamble_ignores_non_string_previous_content(self):
        preamble = AgentBridge._build_planning_preamble(
            {"currentPlan": {"version": 1, "content": 123}}
        )
        assert "Previous plan" not in preamble
