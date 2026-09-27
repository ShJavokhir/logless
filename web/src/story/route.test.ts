import { describe, expect, it } from "vitest";
import { readRoute } from "./route";

describe("explainer routing", () => {
  it("opens the explainer directly without replacing the workspace or product tour", () => {
    expect(readRoute("#/how-it-works")).toEqual({ page: "how-it-works" });
    expect(readRoute("#/explore")).toEqual({ page: "explore" });
    expect(readRoute("#/organize")).toEqual({ page: "story", step: 1 });
  });
  it("does not interpret document anchors as a different page", () => {
    expect(readRoute("#hiw-pipeline")).toBeNull();
    expect(readRoute("#/how-it-works?source=tour")).toEqual({
      page: "how-it-works",
    });
  });
});
