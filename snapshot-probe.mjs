// 直连 mux，拉一次会话快照，统计记录结构
const SID = process.argv[2] || 'session-b63ca026-5952-42bb-8743-1a2d63df192c';
const ws = new WebSocket('ws://127.0.0.1:8781/api/remote.mux');
const streamId = crypto.randomUUID();
ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'open', streamId, endpoint: 'session/follow',
    payload: { args: { request: {
      address: { kind: 'session', sessionId: SID },
      assistantStream: true, maxMessages: 500,
      turnWindow: { minMessages: 50, minTurns: 2 },
    } } },
  }));
};
ws.onmessage = (e) => {
  const s = typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8');
  let j; try { j = JSON.parse(s); } catch { return; }
  if (j.value?.type !== 'snapshot') return;
  const recs = j.value.records || [];
  const types = {};
  for (const r of recs) { const k = (r.event && r.event.type) || r.type || '?'; types[k] = (types[k]||0)+1; }
  console.log('记录数:', recs.length);
  console.log('类型分布:', JSON.stringify(types));
  for (const k of ['user/message','assistant/message','tool/call']) {
    const s = recs.find(r => (r.event&&r.event.type||r.type) === k);
    console.log('样例['+k+']:', JSON.stringify(s).slice(0, 500));
  }
  ws.close(); process.exit(0);
};
ws.onerror = (e) => { console.log('ERR', e.message||e.type); process.exit(1); };
setTimeout(()=>{console.log('timeout');process.exit(1)}, 12000);
