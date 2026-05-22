// netlify/functions/youtube.js
// ─────────────────────────────────────────────────────────────
// YouTube Data API v3 프록시
// search.list로 국가별 짧은 인기 영상 검색 → videos.list → 60초 이하 필터
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

async function fetchRegion(regionCode, apiKey, maxDur, debug) {
  // 국가별 쇼츠 검색어 — "#shorts" + 국가 키워드로 짧은 인기 영상 검색
  const queryMap = {
    KR: '#shorts 쇼츠',
    TH: '#shorts ไทย',
    JP: '#shorts ショート',
    US: '#shorts',
  };
  const q = encodeURIComponent(queryMap[regionCode] || '#shorts');

  // search: q 기반, videoDuration=short, 조회수순. relevanceLanguage 제거(과한 필터 방지)
  const searchUrl = 'https://www.googleapis.com/youtube/v3/search'
    + '?part=snippet'
    + '&type=video'
    + '&q=' + q
    + '&videoDuration=short'
    + '&order=viewCount'
    + '&regionCode=' + regionCode
    + '&maxResults=50'
    + '&key=' + apiKey;

  const sr = await fetch(searchUrl);
  const sj = await sr.json();
  if (sj.error) throw new Error(regionCode + ' search: ' + (sj.error.message || 'API error'));

  const ids = (sj.items || []).map(it => it.id && it.id.videoId).filter(Boolean);
  if (debug) debug[regionCode] = { searchCount: ids.length };
  if (ids.length === 0) return [];

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
      region: regionCode,
      hashtags: (desc.match(/#\S+/g) || []).slice(0, 6),
      thumbnail: v.snippet && v.snippet.thumbnails && v.snippet.thumbnails.high
        ? v.snippet.thumbnails.high.url : '',
    };
  });

  if (debug) {
    debug[regionCode].durations = all.map(s => s.dur).sort((a, b) => a - b);
    debug[regionCode].under60 = all.filter(s => s.dur > 0 && s.dur <= maxDur).length;
  }

  return all
    .filter(s => s.dur > 0 && s.dur <= maxDur)
    .sort((a, b) => b.viewCount - a.viewCount)
    .slice(0, 5);
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
    const maxDur = payload.maxDur || 60;
    const debug = {};

    const results = await Promise.all(
      regions.map(rc => fetchRegion(rc, apiKey, maxDur, debug).catch(e => ({ __error: e.message, rc })))
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
