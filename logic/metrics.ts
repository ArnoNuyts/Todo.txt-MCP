/**
 * Dependency-free in-memory metrics for the HTTP surface.
 *
 * Counters are per process and reset on restart. The Prometheus text format is
 * intentionally simple: one counter per line, no labels, so scrapers and shell
 * scripts can consume it without extra dependencies.
 */

export interface MetricsSnapshot {
  requestsTotal: number;
  responses2xx: number;
  responses4xx: number;
  responses5xx: number;
  responses401: number;
  responses429: number;
  authFailures: number;
}

export interface Metrics {
  recordRequest(status: number): void;
  recordAuthFailure(): void;
  snapshot(): MetricsSnapshot;
  render(): string;
  reset(): void;
}

export function createMetrics(): Metrics {
  const counters: MetricsSnapshot = {
    requestsTotal: 0,
    responses2xx: 0,
    responses4xx: 0,
    responses5xx: 0,
    responses401: 0,
    responses429: 0,
    authFailures: 0,
  };

  return {
    recordRequest(status: number) {
      counters.requestsTotal += 1;
      if (status >= 200 && status < 300) {
        counters.responses2xx += 1;
      } else if (status >= 400 && status < 500) {
        counters.responses4xx += 1;
      } else if (status >= 500 && status < 600) {
        counters.responses5xx += 1;
      }
      if (status === 401) {
        counters.responses401 += 1;
      }
      if (status === 429) {
        counters.responses429 += 1;
      }
    },
    recordAuthFailure() {
      counters.authFailures += 1;
    },
    snapshot() {
      return { ...counters };
    },
    render() {
      return renderPrometheus(counters);
    },
    reset() {
      for (const key of Object.keys(counters) as Array<keyof MetricsSnapshot>) {
        counters[key] = 0;
      }
    },
  };
}

function metric(
  name: string,
  help: string,
  value: number,
): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value}\n`;
}

/** Renders a snapshot in Prometheus text exposition format. */
export function renderPrometheus(snapshot: MetricsSnapshot): string {
  return [
    metric(
      "todo_mcp_requests_total",
      "Total HTTP requests handled.",
      snapshot.requestsTotal,
    ),
    metric(
      "todo_mcp_responses_2xx_total",
      "HTTP responses with a 2xx status.",
      snapshot.responses2xx,
    ),
    metric(
      "todo_mcp_responses_4xx_total",
      "HTTP responses with a 4xx status.",
      snapshot.responses4xx,
    ),
    metric(
      "todo_mcp_responses_5xx_total",
      "HTTP responses with a 5xx status.",
      snapshot.responses5xx,
    ),
    metric(
      "todo_mcp_responses_401_total",
      "HTTP responses with status 401.",
      snapshot.responses401,
    ),
    metric(
      "todo_mcp_responses_429_total",
      "HTTP responses with status 429.",
      snapshot.responses429,
    ),
    metric(
      "todo_mcp_auth_failures_total",
      "Failed bearer-token authentication attempts.",
      snapshot.authFailures,
    ),
  ].join("");
}
