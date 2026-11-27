const {chromium}=require('playwright');const {spawn}=require('child_process');const fs=require('fs');
const [,,mode,name,...ts]=process.argv;const D=__dirname, O=D+'/out/'+name; fs.mkdirSync(D+'/out',{recursive:true});
(async()=>{const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--allow-file-access-from-files']});
const p=await b.newPage({viewport:{width:1080,height:1920}});p.on('pageerror',e=>console.log('ERR',e.message));await p.goto(`file://${D}/${name}.html`);await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(400);
const TOT=await p.evaluate(()=>typeof TOT2!=="undefined"?TOT2:TOT);fs.writeFileSync(O+'-marks.json',JSON.stringify({TOT,M:await p.evaluate(()=>MARKS)}));
if(mode==='p'){for(const t of ts){await p.evaluate(t=>setT(t),+t);await p.waitForTimeout(150);await p.screenshot({path:`${O}-pv${t}.jpg`,type:'jpeg',quality:60})}await b.close();return}
const ff=spawn('ffmpeg',['-y','-v','error','-f','image2pipe','-framerate','30','-i','-','-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p',O+'-v.tmp.mp4'],{stdio:['pipe','ignore','inherit']});
for(let f=0;f<Math.round(TOT*30);f++){await p.evaluate(t=>setT(t),f/30);const buf=await p.screenshot({type:'jpeg',quality:92});if(!ff.stdin.write(buf))await new Promise(r=>ff.stdin.once('drain',r))}
ff.stdin.end();const code=await new Promise(r=>ff.on('close',r));await b.close();if(code===0)fs.renameSync(O+'-v.tmp.mp4',O+'-v.mp4')})();
