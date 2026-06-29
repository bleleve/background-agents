"""Tests for Fountain URL context detection and enrichment."""

import pytest

from sandbox_runtime.fountain_url_context import build_fountain_url_context


class TestWxUrls:
    def test_wx_employer_url_dev(self):
        content = "Fix the job posting form at https://employer.wxp-01.fountain.com/jobs"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "WX" in result
        assert "Employer portal" in result
        assert "wxp-01" in result
        assert "development" in result

    def test_wx_portal_url_production(self):
        content = "Worker can't apply at https://portal.eu-1.fountain.com/apply"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "WX" in result
        assert "Worker portal" in result
        assert "eu-1" in result
        assert "production" in result

    def test_wx_services_url_sandbox(self):
        content = "API error at https://services.sandbox.fountain.com/api/v1/jobs"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "WX" in result
        assert "Backend services" in result
        assert "sandbox" in result

    def test_wx_ftn_app_dev(self):
        content = "Test this on https://employer.wxp-dev.ftn.app/dashboard"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "WX" in result
        assert "development" in result

    def test_wx_portal_ftn_app(self):
        content = "Worker portal issue at portal.wxp-dev.ftn.app"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "WX" in result

    def test_wx_staging_env(self):
        content = "https://employer.wxp-staging.fountain.com/login broken"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "WX" in result
        assert "staging" in result


class TestHireDevUrls:
    def test_hire_dev_01(self):
        content = "Bug reproducible at https://dev-01.fountain.com/signin"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "dev-01" in result
        assert "development" in result

    def test_hire_dev_12(self):
        content = "See https://dev-12.fountain.com for the issue"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "development" in result


class TestHireStagingUrls:
    def test_hire_staging_01(self):
        content = "Staging broke at https://staging-01.fountain.com"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "staging" in result

    def test_hire_staging_use(self):
        content = "Issue at staging-use-19.fountain.com"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "staging" in result

    def test_hire_faut(self):
        content = "Feature UAT at https://faut-01.fountain.com/signin"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "staging" in result

    def test_hire_uat(self):
        content = "UAT environment https://uat-01.fountain.com"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "uat" in result.lower()


class TestHireProductionUrls:
    def test_hire_production_web_multitenant(self):
        content = "Login broken on https://web.fountain.com/signin"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "production" in result

    def test_hire_production_eu1(self):
        content = "EU customers can't log in at eu-1.fountain.com"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "production" in result

    def test_hire_production_ap1(self):
        content = "https://ap-1.fountain.com/apply is down"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "production" in result

    def test_hire_production_us2(self):
        content = "us-2.fountain.com is throwing 500s"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "production" in result

    def test_hire_production_single_tenant_doordash(self):
        content = "Fix the apply button at https://doordash.fountain.com/apply/driver"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "production" in result

    def test_hire_production_single_tenant_amazon_na(self):
        content = "amazon-na.fountain.com/signin is broken"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "production" in result


class TestHireSandboxUrls:
    def test_hire_sandbox_multitenant(self):
        content = "Test at https://sandbox.fountain.com"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "sandbox" in result

    def test_hire_sandbox_single_tenant(self):
        content = "sandbox.ontrac.fountain.com/signin not loading"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "sandbox" in result


class TestHireDemo:
    def test_hire_demo(self):
        content = "Demo env at https://demo.fountain.com"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result
        assert "demo" in result


class TestHireGoUrls:
    def test_go_fountain_com_production(self):
        content = "User can't log in at https://go.fountain.com"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire Go" in result
        assert "production" in result

    def test_go_fountain_com_test_account_path(self):
        content = "Internal test account at https://go.fountain.com/go-test-account"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire Go" in result
        assert "production" in result

    def test_sandbox_go_fountain_com(self):
        content = "Aimbridge sandbox at https://sandbox.go.fountain.com"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire Go" in result
        assert "sandbox" in result

    def test_tryfountain_com_staging(self):
        content = "Profile URL: https://petvet.staging.tryfountain.com/applicants?applicantId=abc"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire Go" in result
        assert "staging" in result

    def test_tryfountain_com_production(self):
        content = "Production Hire Go at https://acme.tryfountain.com/openings"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire Go" in result
        assert "production" in result


class TestFountainOneUrls:
    def test_employer_fountain_com_unified_login(self):
        content = "Login broken at https://employer.fountain.com/home"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Fountain One" in result

    def test_employer_fountain_com_hire_go_redirect(self):
        content = "Redirect stalled at https://employer.fountain.com/hire-go-redirect"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Fountain One" in result


class TestNoUrlDetected:
    def test_no_fountain_url_returns_none(self):
        content = "Fix the login bug in the auth controller"
        result = build_fountain_url_context(content)
        assert result is None

    def test_github_url_not_detected(self):
        content = "See https://github.com/onboardiq/monolith/pull/123 for context"
        result = build_fountain_url_context(content)
        assert result is None

    def test_empty_content(self):
        result = build_fountain_url_context("")
        assert result is None

    def test_irrelevant_urls_only(self):
        content = "Check https://docs.example.com and https://jira.atlassian.net/browse/FOO-1"
        result = build_fountain_url_context(content)
        assert result is None


class TestMultipleUrls:
    def test_multiple_different_urls(self):
        content = (
            "Reproduced on dev-01.fountain.com and also on eu-1.fountain.com "
            "and the WX side at employer.wxp-01.fountain.com"
        )
        result = build_fountain_url_context(content)
        assert result is not None
        assert "dev-01" in result
        assert "eu-1" in result
        assert "WX" in result
        assert "Hire" in result

    def test_same_url_repeated_deduplicated(self):
        content = (
            "Login at dev-01.fountain.com is broken. "
            "Confirmed at dev-01.fountain.com with two accounts."
        )
        result = build_fountain_url_context(content)
        assert result is not None
        # The host should appear in the output exactly once (one entry line) even though
        # the content mentions it twice.
        assert result.count("dev-01.fountain.com") == 1

    def test_url_with_path_detected(self):
        content = "Bug at https://web.fountain.com/accounts/123/jobs/456"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Hire" in result


class TestOutputFormat:
    def test_output_wrapped_in_xml_tags(self):
        content = "Fix https://dev-01.fountain.com/signin"
        result = build_fountain_url_context(content)
        assert result is not None
        assert result.strip().startswith("<fountain_context>")
        assert result.strip().endswith("</fountain_context>")

    def test_output_contains_header_line(self):
        content = "https://web.fountain.com is down"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "Fountain application URL" in result

    def test_output_contains_closing_instruction(self):
        content = "https://dev-01.fountain.com broken"
        result = build_fountain_url_context(content)
        assert result is not None
        assert "codebase" in result.lower() or "service" in result.lower()
