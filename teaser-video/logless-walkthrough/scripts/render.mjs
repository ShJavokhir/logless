import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
mkdirSync('renders',{recursive:true});
const run=(bin,args)=>{const result=spawnSync(bin,args,{stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);};
run('node_modules/.bin/remotion',['render','src/index.ts','Complete30','renders/complete-remotion.mp4','--codec=h264','--audio-codec=aac','--crf=17','--pixel-format=yuv420p','--image-format=png','--concurrency=4',...process.argv.slice(2)]);
// A fresh audio mux gives the PCM source exactly 30s, avoiding Remotion's padded AAC tail.
run('ffmpeg',['-y','-hide_banner','-i','renders/complete-remotion.mp4','-i','public/soundtrack.wav','-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-t','30','-movflags','+faststart','renders/complete-30s.mp4']);
