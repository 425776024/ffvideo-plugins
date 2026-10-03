export const design = (offset = 0) => ({
  intent: '以具体物体的远景和细节切镜说明变化，开场短暂文字后留出干净画面，不采用贯穿标题卡。', background: '#101820',
  captions: { font:'sans-bold',size:30,color:'#f5e8cc',accent:'#ffd078',y:1060,width:600,plateColor:'#102638',plateOpacity:0,entrance:'rise' },
  shots: [
    {sceneIndex:0,start:0,end:.25+offset*.02,frame:{x:0,y:0,width:720,height:1280},endFrame:{x:0,y:0,width:720,height:1280},rotation:0,sourceStart:0,transition:'cut',overlays:[]},
    {sceneIndex:0,start:.25+offset*.02,end:.65,frame:{x:40,y:240+offset*20,width:640,height:720-offset*20},endFrame:{x:40,y:200,width:640,height:800},rotation:0,sourceStart:1,transition:'cut',overlays:[{kind:'text',text:'看细节',start:.1,end:.7,x:360,y:120,width:540,height:80,size:38,font:'serif',color:'#ffbd70',opacity:1,entrance:'slide'}]},
    {sceneIndex:0,start:.65,end:1,frame:{x:0,y:0,width:720,height:1280},endFrame:{x:0,y:0,width:720,height:1280},rotation:0,sourceStart:3,transition:'dissolve',overlays:[]}
  ]
});
export const richDesign = (offset = 0) => ({ ...design(offset), captionKeywords:['观察'], typography:[{
  purpose:'用字号差异呈现观察与细节之间的关系',start:.02,end:.2,x:48,y:80,width:600,align:'left',gap:10,tracking:1,entrance:'rise',
  lines:[{indent:0,delay:0,runs:[{text:'观察',size:72,font:'sans-bold',color:'#f5e8cc',treatment:'fill'},{text:'细节',size:38,font:'serif',color:'#ffd078',treatment:'underline'}]}]
}] });
