import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const databases = __ENV.DATABASES.split(',');
const queries = __ENV.OPERATIONS.split(',');
const trends = {};
for (const database of databases) for (const query of queries) {
  const key = `${database}_${query.replaceAll('-', '_')}`;
  trends[key] = { database: new Trend(`db_${key}`, true), operation: new Trend(`operation_${key}`, true), ...(query === 'insert' ? { generation: new Trend(`generation_${key}`, true) } : {}) };
}
export const options = {
  scenarios: { queries: { executor: 'shared-iterations', iterations: Number(__ENV.ITERATIONS), vus: Number(__ENV.VUS), maxDuration: '10m', gracefulStop: '10s' } },
  thresholds: { http_req_failed: ['rate==0'], checks: ['rate==1'] },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(95)', 'p(99)'],
};
export default function () {
  for (const database of databases) for (const queryId of queries) {
    const insert = queryId === 'insert';
    const response = http.post(`${__ENV.BASE_URL}/api/benchmark/${insert ? 'k6-insert' : 'k6-query'}`, JSON.stringify(insert ? { database, batchKey: `${__VU}-${__ITER}` } : { database, queryId }), {
      headers: { 'Content-Type': 'application/json', 'X-Benchmark-Token': __ENV.BENCHMARK_TOKEN },
      tags: { database, query: queryId }, timeout: '120s',
    });
    const successful = check(response, { 'query completed': r => r.status === 200 });
    if (successful) {
      const result = response.json();
      const trend = trends[`${database}_${queryId.replaceAll('-', '_')}`];
      trend.database.add(result.databaseMs);
      trend.operation.add(result.totalMs);
      if (insert) trend.generation.add(result.generationMs);
    }
  }
}
export function handleSummary(data) {
  return { [__ENV.SUMMARY_PATH]: JSON.stringify(data), stdout: 'k6 benchmark finished.\n' };
}
