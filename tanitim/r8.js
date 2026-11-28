// 8-bit videolar için: sahne 270x480 çizilir, ffmpeg en yakın komşu ile 1080x1920'ye büyütür (gerçek piksel görünümü)
const {chromium}=require('playwright');const {spawn}=require('child_process');const fs=require('fs');
const [,,mode,name,...ts]=process.argv;const D=__dirname, O=D+'/out/'+name; fs.mkdirSync(D+'/out',{recursive:true});
(async()=>{const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--allow-file-access-from-files','--font-render-hinting=none','--disable-font-subpixel-positioning']});
const p=await b.newPage({viewport:{width:270,height:480}});p.on('pageerror',e=>console.log('ERR',e.message));await p.goto(`file://${D}/${name}.html`);await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(500);
const TOT=await p.evaluate(()=>TOT);fs.writeFileSync(O+'-marks.json',JSON.stringify({TOT,M:await p.evaluate(()=>MARKS)}));
const up=['-vf','scale=1080:1920:flags=neighbor,format=yuv420p'];
if(mode==='p'){for(const t of ts){await p.evaluate(t=>setT(t),+t);await p.waitForTimeout(80);const f=`${O}-pv${t}.png`;await p.screenshot({path:f});
  await new Promise(r=>spawn('ffmpeg',['-y','-v','error','-i',f,'-vf','scale=540:960:flags=neighbor',f.replace('.png','.jpg')]).on('close',r))}await b.close();return}
const ff=spawn('ffmpeg',['-y','-v','error','-f','image2pipe','-framerate','30','-i','-',...up,'-c:v','libx264','-preset','veryfast','-crf','16',O+'-v.tmp.mp4'],{stdio:['pipe','ignore','inherit']});
for(let f=0;f<Math.round(TOT*30);f++){await p.evaluate(t=>setT(t),f/30);const buf=await p.screenshot({type:'png'});if(!ff.stdin.write(buf))await new Promise(r=>ff.stdin.once('drain',r))}
ff.stdin.end();const code=await new Promise(r=>ff.on('close',r));await b.close();if(code===0)fs.renameSync(O+'-v.tmp.mp4',O+'-v.mp4')})();
