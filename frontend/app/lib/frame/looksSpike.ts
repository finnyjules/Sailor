// AUTO-GENERATED from the v7 spike (layout-options-v7.html) — the looks Julien
// developed on the spike, captured as real Frame layers to seed the defaults.
// Photos come in as grey STAND-INS (your photo goes here); shapes as placeholder
// ellipses/rects. Hand-edits here are expected — this is the starting point
// Julien tunes into the canonical looks.
import type { LocalLayer } from '~/composables/useCompositorLayers'
let _id = 0
function t(o: any): any { return { id:'t'+(_id++), kind:'text', rotation:0, opacity:1, strokeColor:'#000', strokeWidth:0, ...o } }
function r(o: any): any { return { id:'r'+(_id++), kind:'rect', rotation:0, opacity:1, stroke:'', strokeWidth:0, radius:0, ...o } }
function e(o: any): any { return { id:'e'+(_id++), kind:'ellipse', rotation:0, opacity:1, stroke:'', strokeWidth:0, ...o } }
function img(o: any): any { return { id:'i'+(_id++), kind:'image', rotation:0, opacity:1, filename:'looks-photo3.png', standIn:true, ...o } }
export interface SpikeLook { name: string; bg: string; layers: () => LocalLayer[] }
export const SPIKE_LOOKS: SpikeLook[] = [
  { name:'Run-off', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.0559,y:0.4719,fontSize:0.7157,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:1.9427}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.9298,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Statement', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.5,y:0.0967,fontSize:0.2771,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'center',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9318}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.9298,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.9498,y:0.5,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0.01,lineHeight:1.2,boxW:0.0322})
  ]},
  { name:'Stack', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.3878,y:0.1034,fontSize:0.2606,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.7074}),
    t({text:'NOISE',x:0.3878,y:0.2621,fontSize:0.2606,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.7074}),
    t({text:'NOISE',x:0.3878,y:0.4207,fontSize:0.2606,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.7074}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.5,y:0.5651,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.9318}),
    t({text:'NOISE',x:0.3878,y:0.7379,fontSize:0.2606,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.7074}),
    t({text:'NOISE',x:0.3878,y:0.8965,fontSize:0.2606,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.7074})
  ]},
  { name:'One letter', bg:'#f2f0ef', layers:()=>[
    t({text:'N',x:0.5828,y:0.2423,fontSize:1.0274,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.6738}),
    t({text:'OISE',x:0.1417,y:0.944,fontSize:0.1046,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2153}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.0702,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.2441,y:0.1438,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Index', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.2583,y:0.065,fontSize:0.1652,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.4484}),
    r({x:0.7776,y:0.0255,w:0.3766,h:0.0027,fill:'#121212'}),
    t({text:'Talks on sound and the city',x:0.7776,y:0.0682,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.3766}),
    r({x:0.7776,y:0.0776,w:0.3766,h:0.0027,fill:'#121212'}),
    t({text:'12–14 October 2026',x:0.7776,y:0.105,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.3766}),
    r({x:0.7776,y:0.1298,w:0.3766,h:0.0027,fill:'#121212'}),
    t({text:'Kunsthalle, Hall 2',x:0.7776,y:0.1572,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.3766}),
    r({x:0.7776,y:0.182,w:0.3766,h:0.0027,fill:'#121212'}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7776,y:0.2247,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.3766}),
    r({x:0.7776,y:0.2341,w:0.3766,h:0.0027,fill:'#121212'}),
    t({text:'12–14 October 2026',x:0.4976,y:0.943,fontSize:0.1081,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9269}),
    r({x:0.5,y:0.1274,w:0.9318,h:0.0027,fill:'#121212'})
  ]},
  { name:'Bottom-heavy', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.4952,y:0.9151,fontSize:0.3398,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9223}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.0702,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.0355,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Wall', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.1746,y:0.0556,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.0556,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.0556,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.1289,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.1289,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.1289,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.2022,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.2022,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.2022,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.2755,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.2755,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.2755,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.3488,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.3488,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.3488,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.4221,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.4221,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.4221,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.4954,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.4954,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.4954,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.5686,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.5686,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.5686,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.6419,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.6419,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.6419,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.7152,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.7152,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.7152,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.7885,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.7885,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.7885,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.8618,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.8618,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.8618,fontSize:0.1035,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4889,y:0.5,fontSize:0.4942,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:1.3414}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.0702,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#dd2200',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Staircase', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.3364,y:0.0919,fontSize:0.2227,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.6046}),
    t({text:'NOISE',x:0.5203,y:0.2822,fontSize:0.2227,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.6046}),
    t({text:'NOISE',x:0.7042,y:0.4726,fontSize:0.2227,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.6046}),
    t({text:'NOISE',x:0.8882,y:0.6629,fontSize:0.2227,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.6046}),
    t({text:'NOISE',x:1.0721,y:0.8533,fontSize:0.2227,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.6046}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.7559,y:0.0702,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.2441,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Letter column', bg:'#f2f0ef', layers:()=>[
    t({text:'N',x:0.4691,y:0.1288,fontSize:0.3362,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:0,lineHeight:0.86,boxW:0.2356}),
    t({text:'O',x:0.4791,y:0.3192,fontSize:0.3362,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:0,lineHeight:0.86,boxW:0.2556}),
    t({text:'I',x:0.3946,y:0.5095,fontSize:0.3362,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:0,lineHeight:0.86,boxW:0.0866}),
    t({text:'S',x:0.4576,y:0.6998,fontSize:0.3362,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:0,lineHeight:0.86,boxW:0.2126}),
    t({text:'E',x:0.4504,y:0.8902,fontSize:0.3362,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:0,lineHeight:0.86,boxW:0.198}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.0702,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.2441,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Date as hero', bg:'#f2f0ef', layers:()=>[
    t({text:'12–14\nOctober\n2026',x:0.5,y:0.7134,fontSize:0.2874,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9318}),
    t({text:'NOISE',x:0.1803,y:0.0508,fontSize:0.1077,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2924}),
    t({text:'Talks on sound and the city\nKunsthalle, Hall 2',x:0.7559,y:0.0548,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.2441,y:0.1225,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0.01,lineHeight:1.2,boxW:0.42}),
    r({x:0.5,y:0.0957,w:0.9318,h:0.0027,fill:'#121212'})
  ]},
  { name:'Interleave', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.5,y:0.1154,fontSize:0.3,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'justify',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9318}),
    t({text:'Talksonsoundandthecity',x:0.5,y:0.236,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.9318}),
    t({text:'NOISE',x:0.5,y:0.3534,fontSize:0.3,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9318}),
    t({text:'12–14October2026',x:0.5,y:0.4739,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.9318}),
    t({text:'NOISE',x:0.5,y:0.5913,fontSize:0.3,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'justify',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9318}),
    t({text:'Kunsthalle,Hall2',x:0.5,y:0.7118,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.9318}),
    t({text:'NOISE',x:0.5,y:0.8292,fontSize:0.3,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9318}),
    t({text:'Freeentry·noise.kunsthalle.org',x:0.5,y:0.9498,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.9318})
  ]},
  { name:'Spread', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.5592,y:0.8993,fontSize:0.1558,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:0.76,lineHeight:0.86,boxW:1.0503}),
    t({text:'Talks on sound and the city',x:0.178,y:0.0548,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#dd2200',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.2879}),
    t({text:'12–14 October 2026',x:0.4886,y:0.0548,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.2879}),
    t({text:'Kunsthalle, Hall 2',x:0.7992,y:0.0395,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.2879}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.0355,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  // ── Sentence / slogan looks ─────────────────────────────────────────────────
  // The looks above put a single WORD on the frame; these are built for a PHRASE,
  // set as running type. Block leans on the ragged-last justify (a wrapped column,
  // edges flush, last line ragged); Inline is a flowing paragraph; Highlight
  // reverses the slogan out of stacked knockout bars; Spaced uses vertical justify
  // to fling the phrase, one line per band, down the full height.
  { name:'Sentence · Block', bg:'#f2f0ef', layers:()=>[
    t({text:'SOUND SHAPES THE CITY',x:0.5,y:0.36,fontSize:0.15,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'justify',letterSpacing:-0.03,lineHeight:0.94,boxW:0.9}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.26,y:0.9298,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.74,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Sentence · Inline', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.13,y:0.075,fontSize:0.05,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.02,lineHeight:1,boxW:0.2}),
    t({text:'Three nights of listening — talks, field recordings and live sets tracing how sound builds the city.',x:0.37,y:0.46,fontSize:0.062,fontFamily:'ABC Areal Superfamily Variable',fontWeight:600,color:'#121212',align:'left',letterSpacing:-0.01,lineHeight:1.18,boxW:0.62}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.26,y:0.9298,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.74,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Sentence · Highlight', bg:'#f2f0ef', layers:()=>[
    r({x:0.5,y:0.34,w:0.9,h:0.125,fill:'#121212'}),
    t({text:'MAKE',x:0.5,y:0.34,fontSize:0.1,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#f2f0ef',align:'left',letterSpacing:-0.03,lineHeight:1,boxW:0.82}),
    r({x:0.5,y:0.48,w:0.9,h:0.125,fill:'#121212'}),
    t({text:'SOME',x:0.5,y:0.48,fontSize:0.1,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#f2f0ef',align:'left',letterSpacing:-0.03,lineHeight:1,boxW:0.82}),
    r({x:0.5,y:0.62,w:0.9,h:0.125,fill:'#dd2200'}),
    t({text:'NOISE',x:0.5,y:0.62,fontSize:0.1,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#f2f0ef',align:'left',letterSpacing:-0.03,lineHeight:1,boxW:0.82}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.26,y:0.9298,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.74,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Sentence · Spaced', bg:'#f2f0ef', layers:()=>[
    t({text:'LISTEN\nTO THE\nWHOLE\nCITY',x:0.5,y:0.49,fontSize:0.17,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',valign:'justify',letterSpacing:-0.03,lineHeight:0.9,boxW:0.9,boxH:1.1}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.74,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Photo as field', bg:'#f2f0ef', layers:()=>[
    img({x:0.5,y:0.5,w:1,h:1}),
    r({x:0.5,y:0.9298,w:1,h:0.1404,fill:'#121212'}),
    t({text:'NOISE',x:0.6292,y:0.1327,fontSize:0.4384,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#f2f0ef',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:1.1901}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.9298,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#f2f0ef',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.8951,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#f2f0ef',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Photo as block', bg:'#f2f0ef', layers:()=>[
    img({x:0.262,y:0.5,w:0.4559,h:0.9517}),
    t({text:'NOISE',x:0.9762,y:0.5,fontSize:0.5188,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:1.4084}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.2441,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0.01,lineHeight:1.2,boxW:0.42}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.7379,y:0.0702,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.4559})
  ]},
  { name:'Split', bg:'#f2f0ef', layers:()=>[
    img({x:0.5,y:0.2364,w:1,h:0.4728}),
    t({text:'NOISE',x:0.709,y:0.4728,fontSize:0.4972,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:1.3497}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.9298,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Behind', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.8127,y:0.2774,fontSize:0.5643,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:1.5572}),
    img({x:0.5,y:0.6537,w:1,h:0.6926}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.9298,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#f2f0ef',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#f2f0ef',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Bands', bg:'#f2f0ef', layers:()=>[
    img({x:0.5,y:0.1034,w:1,h:0.2069}),
    t({text:'NOISE',x:0.4955,y:0.2688,fontSize:0.2016,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.5471}),
    img({x:0.5,y:0.4368,w:1,h:0.2069}),
    t({text:'NOISE',x:0.4955,y:0.6021,fontSize:0.2016,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.5471}),
    img({x:0.5,y:0.7701,w:1,h:0.2069}),
    t({text:'NOISE',x:0.4955,y:0.9354,fontSize:0.2016,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.5471}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.0702,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#f2f0ef',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.0355,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#f2f0ef',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Circle photo', bg:'#f2f0ef', layers:()=>[
    img({x:0.525,y:0.7369,w:1.0268,h:0.7268}),
    t({text:'NOISE',x:0.5774,y:0.8476,fontSize:0.3938,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:1.0866}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.0702,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.0355,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Perimeter photo', bg:'#f2f0ef', layers:()=>[
    img({x:0.5,y:0.5,w:1,h:1}),
    t({text:'Talks on sound and the city',x:0.5,y:0.0382,fontSize:0.0311,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#f2f0ef',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.9318}),
    t({text:'12–14 October 2026',x:0.946,y:0.5,fontSize:0.0311,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#f2f0ef',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.0398}),
    t({text:'Kunsthalle, Hall 2',x:0.5,y:0.9618,fontSize:0.0311,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#f2f0ef',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.9318}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.054,y:0.5,fontSize:0.0311,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#f2f0ef',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.0398}),
    t({text:'NOISE',x:0.4694,y:0.8532,fontSize:0.2758,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#f2f0ef',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.7612})
  ]},
  { name:'Slices', bg:'#f2f0ef', layers:()=>[
    img({x:0.5,y:0.168,w:1,h:0.336}),
    img({x:0.5,y:0.5013,w:1,h:0.336}),
    img({x:0.5,y:0.8347,w:1,h:0.336}),
    t({text:'NOISE',x:0.6113,y:0.3851,fontSize:0.4184,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#f2f0ef',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:1.1544}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.0702,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#f2f0ef',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#f2f0ef',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Counter-form', bg:'#f2f0ef', layers:()=>[
    r({x:0.4163,y:0.4864,w:0.9756,h:0.6905,fill:'#dd2200'}),
    t({text:'NOISE',x:0.4843,y:0.2838,fontSize:0.3317,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#f2f0ef',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9004}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.9298,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Knockout', bg:'#f2f0ef', layers:()=>[
    r({x:0.5,y:0.5946,w:1,h:0.655,fill:'#121212'}),
    t({text:'NOISE',x:0.5507,y:0.5945,fontSize:0.3806,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#f2f0ef',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:1.0332}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.0702,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Bleed circle', bg:'#f2f0ef', layers:()=>[
    r({x:0.0941,y:0.8425,w:1.7696,h:1.2525,fill:'#dd2200'}),
    t({text:'NOISE',x:0.7343,y:0.0744,fontSize:0.1652,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.4484}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.9298,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#f2f0ef',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.9645,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Badge', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.5964,y:0.67,fontSize:0.4076,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:1.1246}),
    e({x:0.1425,y:0.8135,w:0.3328,h:0.2355,fill:'#dd2200'}),
    t({text:'12–14\nOctober\n2026',x:0.1425,y:0.8135,fontSize:0.0668,fontFamily:'ABC Areal Superfamily Variable',fontWeight:800,color:'#f2f0ef',align:'center',letterSpacing:-0.045,lineHeight:0.86,boxW:0.3435}),
    t({text:'Talks on sound and the city\nKunsthalle, Hall 2',x:0.2441,y:0.0548,fontSize:0.0339,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.0355,fontSize:0.0268,fontFamily:'ABC Areal Superfamily Variable',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]}
]
