// netlify/functions/youtube.js
// ─────────────────────────────────────────────────────────────
// YouTube Data API v3 프록시
// search.list: publishedAfter(최근 7일) + order=date(최신순)
// → 국가별 "최근 7일 이내 최신 업로드" 영상. 길이 제한 없음(모든 길이).
// videos.list로 조회수·길이·해시태그 보강.
// ─────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function parseDuration(iso) {
  const m = (iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

function formatViews(n) {
  n = parseInt(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

async function fetchRegion(regionCode, apiKey, count, days, debug) {
  // 최근 N일 전 시각 (RFC3339)
  const after = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // 국가별 폭넓은 검색어 — order=date는 q가 있어야 결과가 잘 나옴
  const qMap = { KR: '한국', TH: 'ไทย', JP: '日本', US: 'viral' };
  const q = encodeURIComponent(qMap[regionCode] || 'trending');

  // 1단계: search.list — 최근 N일 이내 업로드, 최신순
  const searchUrl = 'https://www.googleapis.com/youtube/v3/search'
    + '?part=snippet'
    + '&type=video'
    + '&q=' + q
    + '&order=date'                       // 최신 업로드 순
    + '&publishedAfter=' + encodeURIComponent(after)  // 최근 N일 이내
    + '&regionCode=' + regionCode
    + '&maxResults=50'
    + '&key=' + apiKey;

  const sr = await fetch(searchUrl);
  const sj = await sr.json();
  if (sj.error) throw new Error(regionCode + ' search: ' + (sj.error.message || 'API error'));

  const ids = (sj.items || []).map(it => it.id && it.id.videoId).filter(Boolean);
  if (debug) debug[regionCode] = { searchCount: ids.length, publishedAfter: after };
  if (ids.length === 0) return [];

  // 2단계: videos.list — 길이·조회수·해시태그 보강
  const videosUrl = 'https://www.googleapis.com/youtube/v3/videos'
    + '?part=snippet,contentDetails,statistics'
    + '&id=' + ids.slice(0, 50).join(',')
    + '&key=' + apiKey;

  const vr = await fetch(videosUrl);
  const vj = await vr.json();
  if (vj.error) throw new Error(regionCode + ' videos: ' + (vj.error.message || 'API error'));

  const all = (vj.items || []).map(v => {
    const dur = parseDuration(v.contentDetails && v.contentDetails.duration);
    const desc = (v.snippet && v.snippet.description) || '';
    return {
      id: v.id,
      title: (v.snippet && v.snippet.title) || '',
      views: formatViews(v.statistics && v.statistics.viewCount),
      viewCount: parseInt((v.statistics && v.statistics.viewCount) || 0),
      dur,
      publishedAt: (v.snippet && v.snippet.publishedAt) || '',
      region: regionCode,
      hashtags: (desc.match(/#\S+/g) || []).slice(0, 6),
      thumbnail: v.snippet && v.snippet.thumbnails && v.snippet.thumbnails.high
        ? v.snippet.thumbnails.high.url : '',
    };
  });

  if (debug) {
    debug[regionCode].durations = all.map(s => s.dur).sort((a, b) => a - b);
    debug[regionCode].withViews = all.filter(s => s.viewCount > 0).length;
  }

  // 길이 제한 없음(정상 영상만). 최신 업로드 순으로 정렬 후 count개.
  return all
    .filter(s => s.dur > 0)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, count);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'POST만 허용' }) };

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'YOUTUBE_API_KEY 미설정' }) };
  }

  try {
    const payload = JSON.parse(event.body || '{}');
    const regions = Array.isArray(payload.regions) && payload.regions.length ? payload.regions : ['KR', 'TH', 'JP', 'US'];
    const count = Math.min(Math.max(parseInt(payload.count) || 12, 1), 20); // 국가별 노출 개수
    const days = Math.min(Math.max(parseInt(payload.days) || 7, 1), 30);   // 최근 N일 (기본 7)
    const debug = {};

    const results = await Promise.all(
      regions.map(rc => fetchRegion(rc, apiKey, count, days, debug).catch(e => ({ __error: e.message, rc })))
    );

    const out = { errors: [], _debug: debug };
    regions.forEach((rc, i) => {
      const res = results[i];
      const key = rc.toLowerCase();
      if (res && res.__error) { out[key] = []; out.errors.push(rc + ': ' + res.__error); }
      else out[key] = res;
    });

    return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
  } catch (err) {
    return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'YouTube 프록시 오류: ' + err.message }) };
  }
};
