import {Easing, interpolate} from 'remotion';
export const ease = Easing.bezier(0.65, 0, 0.25, 1);
export const p = (t:number,a:number,b:number) => interpolate(t,[a,b],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:ease});
export const mix = (a:number,b:number,t:number) => a+(b-a)*t;
export type View = {x:number;y:number;w:number;h:number;s:number;ix:number;iy:number};
const opening:View={x:940,y:164,w:836,h:814,s:0.98,ix:-243*0.98,iy:-20};
const wide:View={x:160,y:145,w:1600,h:885,s:1600/1440,ix:0,iy:0};
const search:View={...wide,x:206.52,w:1506.96,s:1.26,ix:-244*1.26,iy:-65*1.26};
const detail:View={...wide,x:242.4,w:1435.2,s:1.2,ix:-244*1.2,iy:-72};
const action:View={...detail,h:840,iy:-195};
const story:View={x:1140,y:236,w:520,h:700,s:1.35,ix:-1055*1.35,iy:-323*1.35};
const closing:View={...story,x:2000};
const keys:[number,View][]=[[0,opening],[2.4,opening],[3.3,wide],[4.3,wide],[5.25,search],[11.6,search],[12.5,detail],[14.7,detail],[15.5,action],[21.2,action],[22.15,story],[26.55,story],[27.4,closing],[30,closing]];
export function camera(t:number):View {
  for(let i=0;i<keys.length-1;i++) {
    const [a,va]=keys[i]; const [b,vb]=keys[i+1];
    if(t<=b){const q=p(t,a,b);return Object.fromEntries(Object.keys(va).map(k=>[k,mix(va[k as keyof View],vb[k as keyof View],q)])) as View;}
  }
  return closing;
}
export const states = [
  {at:0,file:'01-overview.png'},
  {at:5.6,file:'02-search.png'},
  {at:8.35,file:'03-analysis-running.png'},
  {at:10.15,file:'04-friction.png'},
  {at:12.2,file:'05-inspect.png'},
  {at:16.7,file:'06-story-loading.png'},
  {at:18.3,file:'07-fictional-story.png'},
];
