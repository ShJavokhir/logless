import React from 'react';
import {Composition,registerRoot} from 'remotion';
import {Film} from './Film';
const Root=()=>React.createElement(Composition,{id:'Complete30',component:Film,durationInFrames:900,fps:30,width:1920,height:1080});
registerRoot(Root);
