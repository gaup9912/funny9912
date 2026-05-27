// netlify/functions/claude.js
// ─────────────────────────────────────────────────────────────
// Anthropic API 스트리밍 프록시 (Netlify Functions v2 / 스트리밍)
// Claude 응답을 토큰이 생성되는 대로 브라우저로 흘려보냄(SSE 패스스루).
// → 연결이 열려있는 동안은 Netlify 10초 제한에 걸리지 않음 (504 해결).
// API 키는 환경변수 ANTHROPIC_API_KEY 에 숨김.
// ─────────────────────────────────────────────────────────────

export default async (request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST만 허용됩니다' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({
      error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. Netlify > Site settings > Environment variables에 추가하세요.',
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: '잘못된 요청 본문' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const body = {
    model: payload.model || 'claude-sonnet-4-20250514',
    max_tokens: payload.max_tokens || 1500,
    messages: payload.messages || [],
    stream: true, // 핵심: Anthropic에 스트리밍 요청
  };
  if (payload.system) body.system = payload.system;
  if (payload.tools) body.tools = payload.tools;
  if (payload.mcp_servers) body.mcp_servers = payload.mcp_servers;

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Claude API 연결 오류: ' + err.message }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => 'upstream error');
    return new Response(JSON.stringify({ error: 'Claude API ' + upstream.status + ': ' + errText.slice(0, 300) }), {
      status: upstream.status || 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // SSE 스트림을 그대로 브라우저로 흘려보냄
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
};
