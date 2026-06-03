// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReviewSuggestionsSummaryResponse } from "@open-inspect/shared";
import { ReviewSuggestionsCards } from "./review-suggestions-cards";

expect.extend(matchers);

afterEach(cleanup);

const summary: ReviewSuggestionsSummaryResponse = {
  total: 30,
  prsReviewed: 12,
  perPr: 2.5,
  resolved: 7,
};

describe("ReviewSuggestionsCards", () => {
  it("renders volume metrics including avg per PR", () => {
    render(<ReviewSuggestionsCards days={30} summary={summary} loading={false} />);

    expect(screen.getByText("PRs reviewed")).toBeInTheDocument();
    expect(screen.getByText("Avg per PR")).toBeInTheDocument();
    expect(screen.getByText("2.5")).toBeInTheDocument();
  });

  it("labels resolved as a proxy, not a quality signal", () => {
    render(<ReviewSuggestionsCards days={30} summary={summary} loading={false} />);

    expect(screen.getByText(/proxy, not a quality signal/i)).toBeInTheDocument();
  });

  it("renders skeletons while loading with no data", () => {
    const { container } = render(
      <ReviewSuggestionsCards days={30} summary={undefined} loading={true} />
    );
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });
});
