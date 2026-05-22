// netlify/functions/youtube.js
// ─────────────────────────────────────────────────────────────
// YouTube Data API v3 프록시
// 브라우저 → 이 함수 → YouTube API → 다시 브라우저
// API 키는 Netlify 환경변수(YOUTUBE_API_KEY)에 숨겨져 노출되지 않음
//
// 호출: POST /.netlify/functions/youtube  { regions: ["KR","TH","JP","US"], maxDur: 15 }
// 응답: { kr:[...], th:[...], jp:[...], us:[...], errors:[...] }
// ─────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ISO 8601 duration → 초
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

async function fetchRegion(regionCode, apiKey, maxDur) {
  const url = 'https://www.googleapis.com/youtube/v3/videos'
    + '?part=snippet,contentDetails,statistics'
    + '&chart=mostPopular'
    + '&regionCode=' + regionCode
    + '&maxResults=50'
    + '&key=' + apiKey;

  const r = await fetch(url);
  const j = await r.json();
  if (j.error) {
    throw new Error(regionCode + ': ' + (j.error.message || 'API error'));
  }
  return (j.items || [])
    .map(v => {
      const dur = parseDuration(v.contentDetails && v.contentDetails.duration);
      const desc = (v.snippet && v.snippet.description) || '';
      return {
        id: v.id,
        title: (v.snippet && v.snippet.title) || '',
        views: formatViews(v.statistics && v.statistics.viewCount),
        dur,
        region: regionCode,
        hashtags: (desc.match(/#\S+/g) || []).slice(0, 6),
        thumbnail: v.snippet && v.snippet.thumbnails && v.snippet.thumbnails.high
          ? v.snippet.thumbnails.high.url : '',
      };
    })
    .filter(s => s.dur > 0 && s.dur <= maxDur)
    .slice(0, 5);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'POST만 허용됩니다' }) };
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'YOUTUBE_API_KEY 환경변수가 설정되지 않았습니다. Netlify > Site settings > Environment variables에 추가하세요.',
      }),
    };
  }

  try {
    const payload = JSON.parse(event.body || '{}');
    const regions = Array.isArray(payload.regions) && payload.regions.length
      ? payload.regions
      : ['KR', 'TH', 'JP', 'US'];
    const maxDur = payload.maxDur || 60; // 수집은 60초 이하 (쇼츠 전체)

    const results = await Promise.all(
      regions.map(rc => fetchRegion(rc, apiKey, maxDur).catch(e => ({ __error: e.message, rc })))
    );

    const out = { errors: [] };
    regions.forEach((rc, i) => {
      const res = results[i];
      const key = rc.toLowerCase();
      if (res && res.__error) {
        out[key] = [];
        out.errors.push(rc);
      } else {
        out[key] = res;
      }
    });

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(out),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'YouTube 프록시 오류: ' + err.message }),
    };
  }
};
