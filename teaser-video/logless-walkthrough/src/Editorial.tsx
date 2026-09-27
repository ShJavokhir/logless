import React from 'react';
import {Brand} from './Brand';
import {p,camera} from './timing';
const Line:React.FC<{children:React.ReactNode;t:number;a:number}> = ({children,t,a})=><div style={{overflow:'hidden',paddingBottom:5}}><div style={{transform:`translateY(${(1-p(t,a,a+0.65))*110}%)`}}>{children}</div></div>;
export const Editorial:React.FC<{t:number}>=({t})=>{
 const introExit=p(t,2.4,3.05); const end=p(t,27.05,27.55); const need=p(t,21.65,22.4)*(1-p(t,26.55,27.05));
 const captions=[{a:3,b:7.95,n:'01',copy:'Find a workflow.'},{a:8,b:11.85,n:'02',copy:'See where work gets stuck.'},{a:11.9,b:16.4,n:'03',copy:'Inspect the aggregate finding.'},{a:16.5,b:21.65,n:'04',copy:'Make the finding tangible.'}];
 return <>
   <div style={{position:'absolute',left:80,top:53}}><Brand/></div>
   <div style={{position:'absolute',right:80,top:61,fontSize:22,color:'#666',letterSpacing:'0.005em'}}>Frontend demo · Mock data</div>
   <div style={{position:'absolute',left:112,top:330,width:810,fontSize:84,lineHeight:1.05,letterSpacing:'-0.055em',fontWeight:500,opacity:1-introExit,transform:`translateX(${-introExit*80}px)`}}>
     <Line t={t} a={0.05}>Find the work</Line><Line t={t} a={0.15}>behind the</Line><Line t={t} a={0.25}>conversations.</Line>
   </div>
   {captions.map(c=><div key={c.n} style={{position:'absolute',left:camera(t).x,top:108,display:'flex',gap:16,alignItems:'center',fontSize:25,opacity:p(t,c.a,c.a+0.28)*(1-p(t,c.b-0.25,c.b)),transform:`translateY(${(1-p(t,c.a,c.a+0.28))*12}px)`}}><span style={{fontSize:17,color:'#777',fontVariantNumeric:'tabular-nums'}}>{c.n}</span><span>{c.copy}</span></div>)}
   <div style={{position:'absolute',left:160,top:348,width:920,opacity:need,transform:`translateX(${(1-need)*-24}px)`}}>
     <div style={{fontSize:22,color:'#686868',marginBottom:28}}>The need behind the pattern</div>
     <div style={{fontSize:88,letterSpacing:'-0.055em',lineHeight:1.07,fontWeight:500}}>Keep a shared<br/>decision intact.</div>
     <div style={{fontSize:26,color:'#666',marginTop:32}}>A fictional story, grounded in aggregate evidence.</div>
   </div>
   <div style={{position:'absolute',left:160,top:320,opacity:end,transform:`translateY(${(1-end)*25}px)`}}>
     <div style={{fontSize:98,lineHeight:1.08,letterSpacing:'-0.055em',fontWeight:500}}>See the pattern.<br/>Understand the need.</div>
     <div style={{marginTop:62,color:'#002FA7',fontSize:30,fontWeight:500,display:'flex',gap:20,alignItems:'center'}}>Explore the demo.<span style={{fontSize:33}}>↗</span></div>
   </div>
 </>;
};
