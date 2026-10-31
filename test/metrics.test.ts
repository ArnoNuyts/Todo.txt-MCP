import { describe, expect, it } from "vitest";
import { createMetrics, renderPrometheus } from "../logic/metrics.ts";

describe("metrics", () => {
  it("counts requests by status class plus 401, 429, and auth failures", () => {
    const metrics = createMetrics();

    for (const status of [200, 204, 302, 401, 404, 429, 500, 503]) {
      metrics.recordRequest(status);
    }
    metrics.recordAuthFailure();
    metrics.recordAuthFailure();

    expect(metrics.snapshot()).toEqual({
      requestsTotal: 8,
      responses2xx: 2,
      responses4xx: 3,
      responses5xx: 2,
      responses401: 1,
      responses429: 1,
      authFailures: 2,
    });
  });

  it("renders Prometheus text with stable metric names", () => {
    const metrics = createMetrics();
    metrics.recordRequest(200);
    metrics.recordRequest(401);
    metrics.recordRequest(429);
    metrics.recordRequest(500);
    metrics.recordAuthFailure();

    const text = metrics.render();
    expect(text).toContain(
      "# TYPE todo_mcp_requests_total counter\ntodo_mcp_requests_total 4",
    );
    expect(text).toContain("todo_mcp_responses_2xx_total 1");
    expect(text).toContain("todo_mcp_responses_4xx_total 2");
    expect(text).toContain("todo_mcp_responses_5xx_total 1");
    expect(text).toContain("todo_mcp_responses_401_total 1");
    expect(text).toContain("todo_mcp_responses_429_total 1");
    expect(text).toContain("todo_mcp_auth_failures_total 1");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("renders a snapshot directly and resets all counters", () => {
    const metrics = createMetrics();
    metrics.recordRequest(500);
    expect(renderPrometheus(metrics.snapshot())).toContain(
      "todo_mcp_responses_5xx_total 1",
    );

    metrics.reset();
    expect(metrics.snapshot()).toEqual({
      requestsTotal: 0,
      responses2xx: 0,
      responses4xx: 0,
      responses5xx: 0,
      responses401: 0,
      responses429: 0,
      authFailures: 0,
    });
  });
});
