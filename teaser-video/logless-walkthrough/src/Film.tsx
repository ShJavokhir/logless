import React from 'react';
import {AbsoluteFill,staticFile,useCurrentFrame} from 'remotion';
import {Audio} from '@remotion/media';
import {Product} from './Product';
import {Editorial} from './Editorial';
export const Film:React.FC=()=>{
 const t=useCurrentFrame()/30;
 return <AbsoluteFill style={{background:'#fafafa',color:'#262626',fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',overflow:'hidden'}}>
  <Audio src={staticFile('soundtrack.wav')}/>
  <Product t={t}/>
  <Editorial t={t}/>
 </AbsoluteFill>;
};
