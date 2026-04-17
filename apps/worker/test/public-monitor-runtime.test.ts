import { describe, expect, it } from 'vitest';

import {
  applyMonitorRuntimeUpdates,
  encodeMonitorRuntimeUpdatesCompact,
  materializeMonitorRuntimeTotals,
  monitorRuntimeUpdateSchema,
  parseMonitorRuntimeUpdate,
  parseMonitorRuntimeUpdates,
  readPublicMonitorRuntimeSnapshot,
  runtimeEntryToHeartbeats,
  writePublicMonitorRuntimeSnapshot,
  type PublicMonitorRuntimeSnapshot,
} from '../src/public/monitor-runtime';
import { createFakeD1Database } from './helpers/fake-d1';

describe('public/monitor-runtime', () => {
  it('advances totals and heartbeat strips incrementally for healthy checks', () => {
    const snapshot: PublicMonitorRuntimeSnapshot = {
      version: 1,
      generated_at: 60,
      day_start_at: 0,
      monitors: [
        {
          monitor_id: 1,
          created_at: 0,
          interval_sec: 60,
          range_start_at: 0,
          materialized_at: 60,
          last_checked_at: 60,
          last_status_code: 'u',
          last_outage_open: false,
          total_sec: 0,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 0,
          heartbeat_gap_sec: '',
          heartbeat_latency_ms: [42],
          heartbeat_status_codes: 'u',
        },
      ],
    };

    const next = applyMonitorRuntimeUpdates(snapshot, 120, [
      {
        monitor_id: 1,
        interval_sec: 60,
        created_at: 0,
        checked_at: 120,
        check_status: 'up',
        next_status: 'up',
        latency_ms: 40,
      },
    ]);

    expect(next.generated_at).toBe(120);
    expect(next.monitors[0]).toMatchObject({
      total_sec: 60,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 60,
      materialized_at: 120,
      last_checked_at: 120,
      last_status_code: 'u',
      last_outage_open: false,
      heartbeat_gap_sec: '1o',
      heartbeat_latency_ms: [40, 42],
      heartbeat_status_codes: 'uu',
    });
  });

  it('stores the post-state status separately from the raw heartbeat result', () => {
    const snapshot: PublicMonitorRuntimeSnapshot = {
      version: 1,
      generated_at: 60,
      day_start_at: 0,
      monitors: [
        {
          monitor_id: 1,
          created_at: 0,
          interval_sec: 60,
          range_start_at: 0,
          materialized_at: 60,
          last_checked_at: 60,
          last_status_code: 'u',
          last_outage_open: false,
          total_sec: 0,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 0,
          heartbeat_gap_sec: '',
          heartbeat_latency_ms: [42],
          heartbeat_status_codes: 'u',
        },
      ],
    };

    const next = applyMonitorRuntimeUpdates(snapshot, 120, [
      {
        monitor_id: 1,
        interval_sec: 60,
        created_at: 0,
        checked_at: 120,
        check_status: 'down',
        next_status: 'up',
        latency_ms: null,
      },
    ]);

    expect(next.monitors[0]).toMatchObject({
      last_status_code: 'u',
      last_outage_open: false,
      heartbeat_status_codes: 'du',
    });
  });

  it('normalizes runtime update latency values to non-negative integers', () => {
    expect(
      monitorRuntimeUpdateSchema.parse({
        monitor_id: 1,
        interval_sec: 60,
        created_at: 0,
        checked_at: 60,
        check_status: 'up',
        next_status: 'up',
        latency_ms: -3.7,
      }),
    ).toMatchObject({
      latency_ms: 0,
    });
  });

  it('rejects invalid privileged runtime update statuses', () => {
    expect(() =>
      monitorRuntimeUpdateSchema.parse({
        monitor_id: 1,
        interval_sec: 60,
        created_at: 0,
        checked_at: 60,
        check_status: 'degraded',
        next_status: 'up',
        latency_ms: 12,
      }),
    ).toThrow();
  });

  it('parses runtime updates with the same privileged latency normalization on the hot path', () => {
    expect(
      parseMonitorRuntimeUpdate({
        monitor_id: 1,
        interval_sec: 60,
        created_at: 0,
        checked_at: 60,
        check_status: 'up',
        next_status: 'up',
        latency_ms: -3.7,
      }),
    ).toEqual({
      monitor_id: 1,
      interval_sec: 60,
      created_at: 0,
      checked_at: 60,
      check_status: 'up',
      next_status: 'up',
      latency_ms: 0,
    });
  });

  it('parses compact runtime update tuples on the hot path', () => {
    expect(
      parseMonitorRuntimeUpdate([1, 60, 0, 60, 'up', 'up', -3.7]),
    ).toEqual({
      monitor_id: 1,
      interval_sec: 60,
      created_at: 0,
      checked_at: 60,
      check_status: 'up',
      next_status: 'up',
      latency_ms: 0,
    });
  });

  it('encodes runtime updates into compact tuples for internal transport', () => {
    expect(
      encodeMonitorRuntimeUpdatesCompact([
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: 0,
          checked_at: 60,
          check_status: 'up',
          next_status: 'down',
          latency_ms: 12,
        },
      ]),
    ).toEqual([[1, 60, 0, 60, 'up', 'down', 12]]);
  });

  it('rejects invalid runtime update arrays on the hot path', () => {
    expect(
      parseMonitorRuntimeUpdates([
        {
          monitor_id: 1,
          interval_sec: 60,
          created_at: 0,
          checked_at: 60,
          check_status: 'up',
          next_status: 'up',
          latency_ms: 12,
        },
        {
          monitor_id: 2,
          interval_sec: 60,
          created_at: 0,
          checked_at: 120,
          check_status: 'degraded',
          next_status: 'up',
          latency_ms: 12,
        },
      ]),
    ).toBeNull();
  });

  it('ignores out-of-order updates for existing runtime entries', () => {
    const snapshot: PublicMonitorRuntimeSnapshot = {
      version: 1,
      generated_at: 120,
      day_start_at: 0,
      monitors: [
        {
          monitor_id: 1,
          created_at: 0,
          interval_sec: 60,
          range_start_at: 0,
          materialized_at: 120,
          last_checked_at: 120,
          last_status_code: 'u',
          last_outage_open: false,
          total_sec: 60,
          downtime_sec: 0,
          unknown_sec: 0,
          uptime_sec: 60,
          heartbeat_gap_sec: '1o',
          heartbeat_latency_ms: [40, 42],
          heartbeat_status_codes: 'uu',
        },
      ],
    };

    const next = applyMonitorRuntimeUpdates(snapshot, 180, [
      {
        monitor_id: 1,
        interval_sec: 60,
        created_at: 0,
        checked_at: 90,
        check_status: 'down',
        next_status: 'down',
        latency_ms: null,
      },
    ]);

    expect(next).toEqual({
      ...snapshot,
      generated_at: 180,
    });
  });

  it('preserves downtime precedence over unknown tail when an outage is open', () => {
    const totals = materializeMonitorRuntimeTotals(
      {
        monitor_id: 1,
        created_at: 0,
        interval_sec: 60,
        range_start_at: 0,
        materialized_at: 120,
        last_checked_at: 120,
        last_status_code: 'x',
        last_outage_open: true,
        total_sec: 120,
        downtime_sec: 60,
        unknown_sec: 0,
        uptime_sec: 60,
        heartbeat_gap_sec: '1o',
        heartbeat_latency_ms: [null, 42],
        heartbeat_status_codes: 'xu',
      },
      180,
    );

    expect(totals.total_sec).toBe(180);
    expect(totals.downtime_sec).toBe(120);
    expect(totals.unknown_sec).toBe(0);
    expect(totals.uptime_sec).toBe(60);
    expect(totals.uptime_pct).toBeCloseTo(100 / 3, 12);
  });

  it('decodes runtime heartbeat strips back into public heartbeat rows', () => {
    const heartbeats = runtimeEntryToHeartbeats({
      monitor_id: 1,
      created_at: 0,
      interval_sec: 60,
      range_start_at: 0,
      materialized_at: 120,
      last_checked_at: 120,
      last_status_code: 'u',
      last_outage_open: false,
      total_sec: 60,
      downtime_sec: 0,
      unknown_sec: 0,
      uptime_sec: 60,
      heartbeat_gap_sec: '1o,1o',
      heartbeat_latency_ms: [40, null, 22],
      heartbeat_status_codes: 'udm',
    });

    expect(heartbeats).toEqual([
      { checked_at: 120, latency_ms: 40, status: 'up' },
      { checked_at: 60, latency_ms: null, status: 'down' },
      { checked_at: 0, latency_ms: 22, status: 'maintenance' },
    ]);
  });

  it('accepts legacy runtime snapshots and normalizes them on read', async () => {
    const db = createFakeD1Database([
      {
        match: 'from public_snapshots',
        first: () => ({
          generated_at: 120,
          body_json: JSON.stringify({
            version: 1,
            generated_at: 120,
            day_start_at: 0,
            monitors: [
              {
                monitor_id: 1,
                created_at: null,
                interval_sec: 60,
                range_start_at: 0,
                materialized_at: 120,
                last_checked_at: 120,
                last_status_code: 'u',
                last_outage_open: false,
                total_sec: 60,
                downtime_sec: 0,
                unknown_sec: 0,
                uptime_sec: 60,
                heartbeat_checked_at: [120, 60, 0],
                heartbeat_latency_ms: [40, null, 22],
                heartbeat_status_codes: 'udm',
              },
            ],
          }),
        }),
      },
    ]);

    const snapshot = await readPublicMonitorRuntimeSnapshot(db, 120);
    expect(snapshot?.monitors[0]?.created_at).toBeNull();
    expect(snapshot?.monitors[0]?.heartbeat_gap_sec).toBe('1o,1o');
    expect(snapshot?.monitors[0] && runtimeEntryToHeartbeats(snapshot.monitors[0])).toEqual([
      { checked_at: 120, latency_ms: 40, status: 'up' },
      { checked_at: 60, latency_ms: null, status: 'down' },
      { checked_at: 0, latency_ms: 22, status: 'maintenance' },
    ]);
  });

  it('does not let an older runtime snapshot overwrite a newer one', async () => {
    const rows = new Map<string, { generated_at: number; body_json: string; updated_at: number }>();
    const db = createFakeD1Database([
      {
        match: 'insert into public_snapshots',
        run: (args) => {
          const [key, generatedAt, bodyJson, updatedAt] = args as [string, number, string, number];
          const existing = rows.get(key);
          if (!existing || generatedAt >= existing.generated_at) {
            rows.set(key, {
              generated_at: generatedAt,
              body_json: bodyJson,
              updated_at: updatedAt,
            });
          }
          return { meta: { changes: 1 } };
        },
      },
    ]);

    const newer: PublicMonitorRuntimeSnapshot = {
      version: 1,
      generated_at: 120,
      day_start_at: 0,
      monitors: [],
    };
    const older: PublicMonitorRuntimeSnapshot = {
      version: 1,
      generated_at: 90,
      day_start_at: 0,
      monitors: [],
    };

    await writePublicMonitorRuntimeSnapshot(db, newer, 140);
    await writePublicMonitorRuntimeSnapshot(db, older, 160);

    expect(rows.get('monitor-runtime')).toEqual({
      generated_at: 120,
      body_json: JSON.stringify(newer),
      updated_at: 140,
    });
  });
});
