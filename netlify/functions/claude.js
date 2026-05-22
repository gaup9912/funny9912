// netlify/functions/claude.js
// ─────────────────────────────────────────────────────────────
// Anthropic API 프록시
// 브라우저 → 이 함수 → Anthropic API → 다시 브라우저
// API 키는 Netlify 환경변수(ANTHROPIC_API_KEY)에 숨겨져 노출되지 않음
// CORS도 같은 사이트(/.netlify/functions/claude)라 자동 해결
// ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // CORS preflight 응답
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'POST만 허용됩니다' }),
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. Netlify > Site settings > Environment variables에 추가하세요.',
      }),
    };
  }

  try {
    const payload = JSON.parse(event.body || '{}');

    // 프론트에서 보낸 system / messages / max_tokens 그대로 전달
    const body = {
      model: payload.model || 'claude-sonnet-4-20250514',
      max_tokens: payload.max_tokens || 1500,
      messages: payload.messages || [],
    };
    if (payload.system) body.system = payload.system;
    if (payload.tools) body.tools = payload.tools;
    if (payload.mcp_servers) body.mcp_servers = payload.mcp_servers;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.text(); // 그대로 패스스루

    return {
      statusCode: res.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: data,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Claude API 프록시 오류: ' + err.message }),
    };
  }
};
