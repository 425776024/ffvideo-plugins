import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { design } from './fixtures/direction.mjs';
import { composeDraft } from '../server/drafts.mjs';
import { validateRecipe } from '../server/recommendation.mjs';
import { validateDesign, designSignature } from '../server/direction.mjs';
import { evaluateVisual, evaluateFrame, ticks, validateProject, transitionWindow, mapTimelineToSource } from '../../packages/core/project.mjs';
const recipe = () => ({title:'镜头原创设计',narration:'先观察整体，再看局部细节。最后回到整体理解它。',language:'zh',tags:['验证'],scenes:[{heading:'观察',body:'内容与镜头联系'}],design:design()});
test('native director executes authored cuts, frame changes, temporary annotation and full narration without template plates',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ffvideo-directed-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const input=recipe(); input.design.shots[1].overlays.unshift({kind:'rect',text:'',start:.1,end:.7,x:360,y:170,width:500,height:4,size:18,font:'sans',color:'#ffbd70',opacity:.8,entrance:'pop'}); const result=await composeDraft(input,directory,{audioPath:new URL('../assets/samples/sample-coast.wav',import.meta.url).pathname,templateId:'science-explainer',presentationStyle:'collage'});
 assert.equal(result.presentationStyle,'directed');assert.equal(result.designVersion,1);assert.equal(result.captionVersion,5);
 const items=result.project.timeline.tracks.flatMap(t=>t.items);
 assert.equal(items.filter(i=>i.name.startsWith('导演镜头')).length,3);
 assert.equal(items.filter(i=>i.name.startsWith('导演标注')).length,2);
 assert.ok(!items.some(i=>['标题栏底板','字幕底板','作品标题','栏目标签'].includes(i.name)));
 const shot=items.find(i=>i.name.startsWith('导演镜头 2'));
 assert.notEqual(evaluateVisual(shot,shot.placement.begin+ticks(.1)).scaleY,evaluateVisual(shot,shot.placement.end-ticks(.1)).scaleY);
 const annotation=items.find(i=>i.name.startsWith('导演标注') && i.clip.text);
 assert.ok(annotation.placement.begin>shot.placement.begin && annotation.placement.end<shot.placement.end);
 assert.equal(annotation.clip.text.fontFamily.includes('Songti') || annotation.clip.text.fontFamily.includes('Serif') || annotation.clip.text.fontFamily.includes('SimSun'),true);
 assert.equal(result.project.timeline.tracks.find(t=>t.name==='逐句字幕').items.map(i=>i.clip.text.content).join(''),input.narration);
 assert.ok(!(await readFile(join(directory,'directed-background.png'))).equals(await readFile(join(directory,'directed-scene-0.png'))));
 assert.equal(validateRecipe(input).design.intent,input.design.intent);
});
test('director rejects permanent fixed layouts, unsafe text, single background for multi-scene work, gaps and executable input',()=>{
 const base=design();const repeated=structuredClone(base);repeated.shots.forEach(s=>{s.frame=structuredClone(base.shots[0].frame);s.endFrame=structuredClone(base.shots[0].endFrame);s.overlays=[];});assert.throws(()=>validateDesign(repeated,1),/fixed card/);
 const single=design();assert.throws(()=>validateDesign(single,3),/distinct scene assets/);
 const unsafe=design();unsafe.shots[1].overlays[0].y=880;unsafe.shots[1].overlays[0].height=100;assert.throws(()=>validateDesign(unsafe,1),/safe area/);
 const gap=design();gap.shots[1].start=.3;assert.throws(()=>validateDesign(gap,1),/continuously/);
 const script=design();script.script='alert(1)';assert.throws(()=>validateDesign(script,1),/unknown field/);
 assert.notEqual(designSignature(design()),designSignature(design(5)));
 const cosmetic=design();cosmetic.background='#FFFFFF';cosmetic.shots[1].sceneIndex=1;cosmetic.shots[1].frame.x+=3;cosmetic.shots[1].overlays[0].text='替换文字';
 assert.equal(designSignature(design()),designSignature(cosmetic));
 const cards=design();cards.shots.forEach(s=>{s.overlays=[120,320].map(y=>({...base.shots[1].overlays[0],y,start:0,end:1}));});
 assert.throws(()=>validateDesign(cards,1),/permanent text cards/);
});

test('video dissolves remain playable at source zero, a loop boundary and the end of a short asset', async t => {
 const {run}=await import('../../packages/server/media.mjs');
 const directory=await mkdtemp(join(tmpdir(),'ffvideo-directed-transitions-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 for (const [name,seconds,sourceStart] of [['long',8,0],['loop',.4,0],['short',.08,59]]) {
  const path=join(directory,name+'.mp4');
  await run('ffmpeg',['-v','error','-y','-f','lavfi','-i',`color=c=blue:s=64x64:r=25:d=${seconds}`,'-c:v','libx264','-pix_fmt','yuv420p',path]);
  const input=recipe();input.design.shots.forEach(shot=>{shot.sourceStart=sourceStart;shot.overlays=[];});input.design.shots[1].transition='dissolve';
  const result=await composeDraft(input,join(directory,name),{durationSeconds:4,visuals:[{sceneIndex:0,path}]});
  validateProject(result.project);
  const footage=result.project.timeline.tracks.find(track=>track.name==='导演剪辑');
  assert.equal(footage.items[0].placement.begin,0);assert.equal(footage.items.at(-1).placement.end,ticks(4));
  footage.items.forEach((item,index)=>{if(index)assert.equal(item.placement.begin,footage.items[index-1].placement.end,'continuous footage without a blank gap');});
  assert.equal(result.project.timeline.transitions.length,2,'preserve both authored dissolves');
  if(seconds<4)assert(footage.items.length>3,'short media wraps without stretching its clock');
  for(const transition of result.project.timeline.transitions){
   const window=transitionWindow(result.project,transition);
   const from=footage.items.find(item=>item.id===transition.fromItemId),to=footage.items.find(item=>item.id===transition.toItemId);
   for(const item of [from,to]){
    const asset=result.project.assets.find(a=>a.id===item.clip.assetId);
    assert(mapTimelineToSource(item,window.begin,{clamp:false})>=0,`${name}: no read before the source`);
    assert(mapTimelineToSource(item,window.end,{clamp:false})<=asset.duration,`${name}: no read after the source`);
   }
   const layers=evaluateFrame(result.project,from.placement.end).layers;
   assert(layers.some(layer=>layer.itemId===from.id));assert(layers.some(layer=>layer.itemId===to.id));
  }
 }
});

test('a slightly overlong local narration keeps its full track within the automatic 60-second limit without truncation', async t=>{
 const {run,probe}=await import('../../packages/server/media.mjs');const directory=await mkdtemp(join(tmpdir(),'ffvideo-directed-duration-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const source=join(directory,'source.wav');await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=220:sample_rate=24000:duration=63','-ac','1',source]);
 const input=recipe();const result=await composeDraft(input,directory,{audioPath:source,maxDurationSeconds:60});
 assert.ok(result.durationSeconds<=60 && result.durationSeconds>59);
 assert.equal((await probe(source)).duration,ticks(63),'Original narration remains available');
 const audio=result.project.assets.find(a=>a.kind==='audio');assert.ok(audio.path.endsWith('directed-narration.wav'));
 assert.equal(result.project.timeline.tracks.find(t=>t.name==='逐句字幕').items.map(i=>i.clip.text.content).join(''),input.narration);
});
