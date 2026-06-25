import { describe, expect, it } from 'vitest';
import {
  PublicDataMesh,
  parseEiaSeriesResponse,
  parseSecEdgarRss,
  sourceTrustTier,
  type PublicDataMeshSink,
} from './publicDataMesh.js';

function captureSink() {
  const sources: unknown[] = [];
  const observations: unknown[] = [];
  const releases: unknown[] = [];
  const sink: PublicDataMeshSink = {
    insertPublicDataSource: (source) => { sources.push(source); },
    insertPublicDataObservation: (observation) => { observations.push(observation); },
    insertPublicDataRelease: (release) => { releases.push(release); },
  };
  return { sink, sources, observations, releases };
}

describe('public data source trust', () => {
  it('assigns official sources to high-trust tiers', () => {
    expect(sourceTrustTier('sec-edgar')).toBe(1);
    expect(sourceTrustTier('eia')).toBe(1);
    expect(sourceTrustTier('nws')).toBe(1);
    expect(sourceTrustTier('gdelt')).toBe(3);
  });
});

describe('public data parsers', () => {
  it('normalizes EIA energy observations from series data', () => {
    const observations = parseEiaSeriesResponse('PET.RWTC.D', 'WTI spot price', {
      response: {
        data: [
          { period: '2026-06-24', value: '82.41', units: 'dollars per barrel' },
          { period: '2026-06-23', value: '81.20', units: 'dollars per barrel' },
        ],
      },
    }, 1_772_000_000_000);

    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      source_id: 'eia',
      key: 'PET.RWTC.D',
      value: 82.41,
      unit: 'dollars per barrel',
      timestamp: Date.parse('2026-06-24T00:00:00.000Z'),
      observed_at: 1_772_000_000_000,
    });
  });

  it('normalizes SEC EDGAR RSS items into release records', () => {
    const releases = parseSecEdgarRss(`
      <rss><channel>
        <item>
          <title>10-K - ACME CORP (0000000001)</title>
          <link>https://www.sec.gov/Archives/edgar/data/1/index.html</link>
          <pubDate>Thu, 25 Jun 2026 14:30:00 GMT</pubDate>
          <description>Annual report filed by ACME CORP</description>
        </item>
      </channel></rss>
    `, 1_772_000_000_000);

    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      source_id: 'sec-edgar',
      title: '10-K - ACME CORP (0000000001)',
      url: 'https://www.sec.gov/Archives/edgar/data/1/index.html',
      trust_tier: 1,
    });
  });
});

describe('PublicDataMesh', () => {
  it('writes normalized sources, observations, releases, and freshness state', () => {
    const { sink, sources, observations, releases } = captureSink();
    const mesh = new PublicDataMesh({ sink, staleAfterMs: { eia: 60_000, 'sec-edgar': 120_000 } });

    mesh.ingestSource({ id: 'eia', name: 'EIA Energy', category: 'energy', stale_after_ms: 60_000 });
    mesh.ingestObservation({
      id: 'obs-1',
      source_id: 'eia',
      key: 'PET.RWTC.D',
      value: 82.41,
      unit: 'dollars per barrel',
      timestamp: 1_772_000_000_000,
      observed_at: 1_772_000_000_000,
      metadata_json: '{}',
    });
    mesh.ingestRelease({
      id: 'release-1',
      source_id: 'sec-edgar',
      title: '10-K - ACME CORP',
      url: 'https://www.sec.gov/example',
      published_at: 1_772_000_001_000,
      observed_at: 1_772_000_001_000,
      summary: 'Annual report',
      trust_tier: 1,
      metadata_json: '{}',
    });

    const state = mesh.getState(1_772_000_030_000);

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'eia' }),
      expect.objectContaining({ id: 'sec-edgar' }),
    ]));
    expect(observations).toHaveLength(1);
    expect(releases).toHaveLength(1);
    expect(state.sources[0]).toMatchObject({ id: 'eia', trust_tier: 1 });
    expect(state.freshness.find((row) => row.source_id === 'eia')).toMatchObject({ stale: false, age_ms: 30_000 });
    expect(state.freshness.find((row) => row.source_id === 'sec-edgar')).toMatchObject({ stale: false, age_ms: 29_000 });
  });
});
