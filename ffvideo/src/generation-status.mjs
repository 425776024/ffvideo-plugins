export function generationMessage({ service = {}, jobs = [], selectedJobs = [], completed = 0, autoGenerate = false }) {
  const running = jobs.find(job => job.status === 'composing') || jobs.find(job => job.status === 'claimed');
  const failed = selectedJobs.filter(job => job.status === 'failed').at(-1);
  const error = running?.error || failed?.error || (service.blocked ? service.lastError : '') || '';
  if (service.blocked) return { title: '制作已停止，请重连', detail: error, error };
  if (running) {
    const phase = { 'script-connect': '正在连接制作服务', script: '正在构思作品', 'script-writing': '正在编写脚本',
      'script-reconnect': '正在恢复模型连接', media: '正在准备画面', visuals: '正在准备画面', speech: '正在制作配音',
      waiting_for_browser: '等待配音服务连接', model_required: '配音模型需要准备' }[running.phase] || '正在合成作品';
    const elapsed = service.elapsedSeconds >= 20 ? ` · ${service.elapsedSeconds}s` : '';
    const detail = running.phase === 'script-writing' ? `已收到 ${running.scriptCharacters || 0} 字脚本，完成后立即制作。` : '每完成一条立即显示，可以先播放已完成的作品。';
    const received = running.phase === 'script-writing' && running.scriptCharacters ? ` · ${running.scriptCharacters}字` : elapsed;
    return { title: `${phase}${received}${completed ? ` · 已完成 ${completed} 条` : ''}`, detail, error };
  }
  // A failed request must remain visible even when other jobs are queued.
  if (failed) return { title: `制作暂未完成 · 已完成 ${completed} 条`, detail: error || '可以点击重试。', error };
  if (jobs.length) return { title: `还有 ${jobs.length} 条作品待制作`, detail: '每完成一条立即显示。', error: '' };
  return { title: `${completed} 条作品`, detail: autoGenerate ? '围绕当前话题准备后面 3 条，完成一条立即追加。' : '点击继续生成，制作这个话题的更多作品。', error: '' };
}
