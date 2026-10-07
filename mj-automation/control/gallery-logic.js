/* Pure gallery decisions: no submission, filesystem or authorization. */
(function (root) {
  'use strict';
  function aspectOf(a) {
    return typeof a.requestedAspect === 'string' ? a.requestedAspect : typeof a.aspect === 'string' ? a.aspect : a.aspect?.requested || '';
  }
  function shapeOf(a) {
    if (!(a.width > 0 && a.height > 0)) return 'unknown';
    return a.width === a.height ? 'square' : a.width > a.height ? 'landscape' : 'portrait';
  }
  function filter(assets, f) {
    const words=(f.search || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const rows=assets.filter(a => {
      const text=[a.name,a.prompt,a.jobId,a.batchName,...(a.tags || [])].join(' ').toLocaleLowerCase();
      return words.every(w=>text.includes(w)) && (!f.job || a.jobId===f.job) && (!f.batch || a.batchId===f.batch)
        && (!f.tag || (a.tags || []).includes(f.tag)) && (!f.version || a.version===f.version)
        && (!f.shape || shapeOf(a)===f.shape) && (f.status==='all' || f.status==='favorite' && a.favorite
          || f.status==='archived' && a.archived || (!f.status || f.status==='active') && !a.archived);
    });
    return rows.sort((a,b) => f.sort==='oldest' ? a.createdAt-b.createdAt || a.id.localeCompare(b.id)
      : f.sort==='name' ? String(a.name).localeCompare(String(b.name),'zh-CN') || a.id.localeCompare(b.id)
      : (f.sort==='favorite' ? Number(b.favorite)-Number(a.favorite) : 0) || b.createdAt-a.createdAt || a.id.localeCompare(b.id));
  }
  function reuse(a) {
    const aspect=aspectOf(a), version=typeof a.version==='string'?a.version:'', params=a.params && typeof a.params==='object' && !Array.isArray(a.params) ? {...a.params} : {};
    const missing=[];
    if (!a.prompt?.trim()) missing.push('提示词');
    if (!/^\d+:\d+$/.test(aspect)) missing.push('画幅');
    if (!version) missing.push('版本');
    if (a.params==null) missing.push('高级参数');
    return {item:{name:a.name || '复用创意',prompt:a.prompt || '',aspect:/^\d+:\d+$/.test(aspect)?aspect:'',version,params},missing};
  }
  function differences(rows) {
    const fields=['prompt','version','requestedAspect','params'];
    return fields.filter(k=>new Set(rows.map(a=>JSON.stringify(k==='requestedAspect'?aspectOf(a):k==='params'?(a.params==null?null:Object.fromEntries(Object.entries(a.params).sort(([x],[y])=>x.localeCompare(y)))):a[k] ?? null))).size>1);
  }
  const api={aspectOf,shapeOf,filter,reuse,differences};
  if (typeof module!=='undefined') module.exports=api;
  else root.MulticaGallery=api;
})(typeof globalThis!=='undefined'?globalThis:this);
