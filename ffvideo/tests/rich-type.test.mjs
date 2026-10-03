import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { design } from './fixtures/direction.mjs';
import { captionRuns, renderTypeLayers } from '../server/rich-type.mjs';
import { validateDesign, designSignature } from '../server/direction.mjs';
import { composeDraft } from '../server/drafts.mjs';
import { validateRecipe } from '../server/recommendation.mjs';
import { evaluateVisual, ticks } from '../../packages/core/project.mjs';
const run=(text,size=60,treatment='fill')=>({text,size,font:'sans-bold',color:'#ffe3a2',treatment});
const richDesign=()=>({...design(),captionKeywords:['整体','细节'],typography:[{
 purpose:'先给出观察尺度，再突出核心概念',start:0,end:.2,x:48,y:100,width:600,align:'left',gap:10,tracking:1,entrance:'rise',
 lines:[{indent:0,delay:0,runs:[run('观察尺度',22)]},{indent:36,delay:.1,runs:[run('整体',90,'outline'),run('与',30),run('细节',60,'underline')]}]
}]});
test('keyword emphasis preserves every narration character and resolves overlaps without full-sentence recoloring',()=>{
 const input='观察整体，再看细节，观察整体。',runs=captionRuns(input,['整体','观察整体','细节'],{size:30,font:'serif',color:'#ffffff',accent:'#ffe3a2'});
 assert.equal(runs.map(r=>r.text).join(''),input);assert.equal(runs.filter(r=>r.treatment==='underline').map(r=>r.text).join('|'),'观察整体|细节|观察整体');
 assert.ok(runs.some(r=>r.color==='#ffffff'));
});
test('authored hierarchy is bounded, required for new type plans and counted in structural uniqueness',()=>{
 const d=richDesign();assert.equal(validateDesign(d,1).typography[0].lines.length,2);
 const uniform=richDesign();uniform.typography[0].lines.forEach(line=>line.runs.forEach(r=>{r.size=30;r.treatment='fill';}));assert.throws(()=>validateDesign(uniform,1),/meaningful hierarchy/);
 const clipped=richDesign();clipped.typography[0].x=120;assert.throws(()=>validateDesign(clipped,1),/safe width/);
 const invalid=richDesign();invalid.typography[0].lines[0].runs[0].text+='\n';assert.throws(()=>validateDesign(invalid,1),/printable/);
 const permanent=richDesign();permanent.typography[0].start=0;permanent.typography[0].end=1;permanent.typography.push(structuredClone(permanent.typography[0]));assert.throws(()=>validateDesign(permanent,1),/permanent text cards/);
 const cosmetic=richDesign();cosmetic.typography[0].lines[1].runs[0].color='#aaffcc';assert.equal(designSignature(d),designSignature(cosmetic));
 const changed=richDesign();changed.typography[0].lines[1].indent=120;assert.notEqual(designSignature(d),designSignature(changed));
});
test('local measured rich typography becomes animated native alpha assets above footage, retaining full subtitle text',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ffvideo-type-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const input={title:'文字层级',narration:'先观察整体，再看局部细节。最后回到整体理解它。',language:'zh',tags:['验证'],scenes:[{heading:'观察',body:'整体与细节'}],design:richDesign()};
 const result=await composeDraft(input,directory,{audioPath:new URL('../assets/samples/sample-coast.wav',import.meta.url).pathname});
 assert.equal(result.designVersion,2);assert.equal(result.captionVersion,6);
 const p=result.project,items=p.timeline.tracks.flatMap(t=>t.items),types=items.filter(i=>i.name.startsWith('文字编排'));
 assert.equal(types.length,2);assert.ok(types[1].placement.begin!==types[0].placement.begin);
 assert.ok(types.every(i=>i.clip.type==='image' && i.clip.visual.scaleY<.2));
 assert.ok(!items.some(i=>i.clip.html));
 const track=p.timeline.tracks.find(t=>t.name==='逐句重点字幕');assert.ok(p.timeline.tracks.indexOf(track)<p.timeline.tracks.findIndex(t=>t.name==='导演剪辑'));
 assert.equal(p.timeline.tracks.find(t=>t.name==='逐句字幕').items.map(i=>i.clip.text.content).join(''),input.narration);
 assert.ok(p.timeline.tracks.find(t=>t.name==='逐句字幕').items.every(i=>evaluateVisual(i,i.placement.begin+ticks(.1)).opacity===0));
 const rejected=structuredClone(input);rejected.design.captionKeywords=['虚构词语'];await assert.rejects(composeDraft(rejected,directory,{durationSeconds:20}),/真实旁白/);
 assert.throws(()=>validateRecipe(rejected),/真实旁白/,'Invalid emphasis fails before taking material or speech resources');
 const fractional=await composeDraft({...input,narration:input.narration.repeat(4)},directory,{durationSeconds:21.46341});
 for (const i of fractional.project.timeline.tracks.flatMap(t=>t.items)) for (const binding of Object.values(i.clip.automation || {})) for (const key of binding.keyframes)
   assert.ok(Number.isSafeInteger(key.time) && key.time<=i.placement.end-i.placement.begin,'Fractional narration must not leave subtitle keyframes one tick beyond their clip');
});
test('font measurement refuses an overcrowded or vertically clipped layout rather than dropping words',async()=>{
 const request={id:'overflow',x:40,y:100,width:120,align:'left',gap:10,tracking:0,lines:[{indent:0,delay:0,runs:[{...run('这段内容太长不应该被截掉',80),family:'sans-serif',weight:600}]}]};
 await assert.rejects(renderTypeLayers([request]),/过密/);
 const clipped={...request,width:600,y:900,lines:[{indent:0,delay:0,runs:[{...run('观察',80),family:'sans-serif',weight:600}]}]};
 await assert.rejects(renderTypeLayers([clipped]),/安全区/);
});
