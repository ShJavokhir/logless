import React from 'react';
import {Img,staticFile} from 'remotion';
import {camera,p,states,mix} from './timing';
// Cursor coordinates stay in source screenshot pixels; the shared camera maps them once.
const points:[number,number,number][]=[[4.9,720,460],[5.35,450,313],[5.6,450,313],[6.1,585,345],[11.2,650,390],[11.95,480,482],[12.2,480,482],[12.8,550,560],[15.65,1100,760],[16.45,1220,831],[16.7,1220,831],[17.2,1280,858]];
function pointer(t:number){for(let i=0;i<points.length-1;i++){const[a,x,y]=points[i];const[b,u,v]=points[i+1];if(t<=b){const q=p(t,a,b);return{x:mix(x,u,q),y:mix(y,v,q)};}}return{x:1280,y:858};}
export const Product:React.FC<{t:number}>=({t})=>{
 const c=camera(t); const pos=pointer(t);
 const pointerOpacity=(p(t,4.9,5.1)*(1-p(t,6.3,6.6)))+(p(t,11.2,11.4)*(1-p(t,12.8,13.1)))+(p(t,15.65,15.9)*(1-p(t,17.2,17.45)));
 const click=[5.55,12.12,16.62].reduce((m,at)=>Math.max(m,1-p(Math.abs(t-at),0,0.2)),0);
 return <div style={{position:'absolute',left:c.x,top:c.y,width:c.w,height:c.h,border:'1px solid #dddddf',borderRadius:12,overflow:'hidden',background:'#fff'}}>
   <div style={{position:'absolute',width:1440,height:900,left:c.ix,top:c.iy,transform:`scale(${c.s})`,transformOrigin:'0 0'}}>
     {states.map((state,i)=><Img key={state.file} src={staticFile(state.file)} style={{position:'absolute',width:1440,height:900,opacity:i===0?1:p(t,state.at,state.at+0.16)}}/>)}
   </div>
   <div style={{position:'absolute',left:c.ix+pos.x*c.s,top:c.iy+pos.y*c.s,opacity:pointerOpacity,transform:`scale(${1-click*0.12})`,transformOrigin:'0 0'}}>
     <svg width="27" height="33" viewBox="0 0 27 33"><path d="M1.5 1.5L23.5 16.5L13.9 18.3L19.5 28.8L14.9 31.2L9.6 20.6L3 27Z" fill="#242424" stroke="white" strokeWidth="2.2" strokeLinejoin="round"/></svg>
   </div>
 </div>;
};
