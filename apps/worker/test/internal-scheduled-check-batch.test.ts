import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/scheduler/scheduled', () => ({
  listMonitorRowsByIds: vi.fn(),
  runPersistedMonitorBatch: vi.fn(),
}));

import type { Env } from '../src/env';
import worker from '../src/index';
import {
  listMonitorRowsByIds,
  runPersistedMonitorBatch,
} from '../src/scheduler/scheduled';
import { createFakeD1Database } from './helpers/fake-d1';

describe('internal scheduled check-batch route', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('rejects stale and future checked_at values even with a valid token', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-15T05:18:20.000Z').valueOf());

    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const makeRequest = (checkedAt: number) =>
      worker.fetch(
        new Request('https://status.example.com/api/v1/internal/scheduled/check-batch', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-admin-token',
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            token: 'test-admin-token',
            ids: [1],
            checked_at: checkedAt,
            state_failures_to_down_from_up: 2,
            state_successes_to_up_from_down: 2,
          }),
        }),
        env,
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
      );

    await expect(makeRequest(1_776_230_340)).resolves.toMatchObject({ status: 403 });
    await expect(makeRequest(1_776_230_160)).resolves.toMatchObject({ status: 403 });
  });

  it('returns compact runtime updates when requested by the scheduler service', async () => {
    const now = new Date('2026-04-15T05:18:20.000Z').valueOf();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    vi.mocked(listMonitorRowsByIds).mockResolvedValue([
      {
        id: 1,
        name: 'API',
        type: 'http',
        target: 'https://example.com',
        interval_sec: 60,
        created_at: 1_776_230_000,
        timeout_ms: 10_000,
        http_method: 'GET',
        http_headers_json: null,
        http_body: null,
        expected_status_json: null,
        response_keyword: null,
        response_keyword_mode: null,
        response_forbidden_keyword: null,
        response_forbidden_keyword_mode: null,
        state_status: 'up',
        state_last_error: null,
        last_checked_at: 1_776_230_220,
        last_changed_at: 1_776_230_000,
        consecutive_failures: 0,
        consecutive_successes: 1,
      },
    ] as never);
    vi.mocked(runPersistedMonitorBatch).mockResolvedValue({
      runtimeUpdates: [
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: 1_776_230_000,
          checked_at: 1_776_230_280,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 21,
        },
      ],
      stats: {
        processedCount: 1,
        rejectedCount: 0,
        attemptTotal: 1,
        httpCount: 1,
        tcpCount: 0,
        assertionCount: 0,
        downCount: 0,
        unknownCount: 0,
      },
      checksDurMs: 4,
      persistDurMs: 2,
    });

    const env = {
      DB: createFakeD1Database([]),
      ADMIN_TOKEN: 'test-admin-token',
    } as unknown as Env;

    const res = await worker.fetch(
      new Request('https://status.example.com/api/v1/internal/scheduled/check-batch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Uptimer-Internal-Format': 'compact-v1',
        },
        body: JSON.stringify({
          token: 'test-admin-token',
          ids: [1],
          checked_at: 1_776_230_280,
          state_failures_to_down_from_up: 2,
          state_successes_to_up_from_down: 2,
        }),
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      runtime_updates: [[1, 60, 1_776_230_000, 1_776_230_280, 'up', 'up', 21]],
      processed_count: 1,
      checks_duration_ms: 4,
      persist_duration_ms: 2,
    });
  });
});
