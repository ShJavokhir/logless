import { describe, expect, it } from "vitest";
import { readRoute } from "./route";

describe("explainer routing", () => {
  it("opens the explainer directly without replacing the workspace or product tour", () => {
    expect(readRoute("#/how-it-works")).toEqual({ page: "how-it-works" });
    expect(readRoute("#/explore")).toEqual({ page: "explore" });
    expect(readRoute("#/loggy")).toEqual({ page: "demo", tab: "loggy" });
  });
  it("does not interpret document anchors as a different page", () => {
    expect(readRoute("#hiw-pipeline")).toBeNull();
    expect(readRoute("#/how-it-works?source=tour")).toEqual({
      page: "how-it-works",
    });
  });
  it("routes a paired phone without changing the demo tabs", () => {
    expect(readRoute("#/remote/abc123/secret-token")).toEqual({
      page: "remote", sessionId: "abc123", token: "secret-token",
    });
    expect(readRoute("#/remote/abc123")).toEqual({
      page: "remote", sessionId: "abc123", token: null,
    });
    expect(readRoute("#/build")).toEqual({ page: "demo", tab: "build" });
  });
});
