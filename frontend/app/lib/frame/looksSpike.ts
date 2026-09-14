// AUTO-GENERATED from the v7 spike (layout-options-v7.html) — the looks Julien
// developed on the spike, captured as real Frame layers to seed the defaults.
// Regenerate by re-running the extractor; hand-edits here are expected (this is
// the starting point Julien tunes into the canonical looks).
import type { LocalLayer } from '~/composables/useCompositorLayers'
let _id = 0
function t(o: any): any { return { id:'t'+(_id++), kind:'text', rotation:0, opacity:1, strokeColor:'#000', strokeWidth:0, ...o } }
function r(o: any): any { return { id:'r'+(_id++), kind:'rect', rotation:0, opacity:1, stroke:'', strokeWidth:0, radius:0, ...o } }
export interface SpikeLook { name: string; bg: string; layers: () => LocalLayer[] }
export const SPIKE_LOOKS: SpikeLook[] = [
  { name:'Run-off', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.0559,y:0.4719,fontSize:0.7157,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:1.9427}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.9298,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.9645,fontSize:0.0268,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Stack', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.3878,y:0.1034,fontSize:0.2606,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.7074}),
    t({text:'NOISE',x:0.3878,y:0.2621,fontSize:0.2606,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.7074}),
    t({text:'NOISE',x:0.3878,y:0.4207,fontSize:0.2606,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.7074}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.5,y:0.5651,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.9318}),
    t({text:'NOISE',x:0.3878,y:0.7379,fontSize:0.2606,fontFamily:'Inter Tight',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.7074}),
    t({text:'NOISE',x:0.3878,y:0.8965,fontSize:0.2606,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.7074})
  ]},
  { name:'One letter', bg:'#f2f0ef', layers:()=>[
    t({text:'N',x:0.5828,y:0.2423,fontSize:1.0274,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.6738}),
    t({text:'OISE',x:0.1417,y:0.944,fontSize:0.1046,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2153}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.0702,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.2441,y:0.1438,fontSize:0.0268,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Index', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.2583,y:0.065,fontSize:0.1652,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.4484}),
    t({text:'Talks on sound and the city',x:0.7776,y:0.0682,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.3766}),
    t({text:'12–14 October 2026',x:0.7776,y:0.105,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.3766}),
    t({text:'Kunsthalle, Hall 2',x:0.7776,y:0.1572,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.3766}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7776,y:0.2247,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.3766}),
    t({text:'12–14 October 2026',x:0.4976,y:0.943,fontSize:0.1081,fontFamily:'Inter Tight',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9269})
  ]},
  { name:'Bottom-heavy', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.4952,y:0.9151,fontSize:0.3398,fontFamily:'Inter Tight',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9223}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.0702,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.0355,fontSize:0.0268,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Wall', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.1746,y:0.0556,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.0556,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.0556,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.1289,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.1289,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.1289,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.2022,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.2022,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.2022,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.2755,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.2755,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.2755,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.3488,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.3488,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.3488,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.4221,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.4221,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.4221,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.4954,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.4954,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.4954,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.5686,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.5686,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.5686,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.6419,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.6419,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.6419,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.7152,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.7152,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.7152,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.7885,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.7885,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.7885,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.1746,y:0.8618,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4852,y:0.8618,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.7959,y:0.8618,fontSize:0.1035,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2811}),
    t({text:'NOISE',x:0.4889,y:0.5,fontSize:0.4942,fontFamily:'Inter Tight',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:1.3414}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.0702,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#dd2200',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.9645,fontSize:0.0268,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Staircase', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.3364,y:0.0919,fontSize:0.2227,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.6046}),
    t({text:'NOISE',x:0.5203,y:0.2822,fontSize:0.2227,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.6046}),
    t({text:'NOISE',x:0.7042,y:0.4726,fontSize:0.2227,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.6046}),
    t({text:'NOISE',x:0.8882,y:0.6629,fontSize:0.2227,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.6046}),
    t({text:'NOISE',x:1.0721,y:0.8533,fontSize:0.2227,fontFamily:'Inter Tight',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.6046}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.7559,y:0.0702,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'right',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.2441,y:0.9645,fontSize:0.0268,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Letter column', bg:'#f2f0ef', layers:()=>[
    t({text:'N',x:0.4691,y:0.1288,fontSize:0.3362,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:0,lineHeight:0.86,boxW:0.2356}),
    t({text:'O',x:0.4791,y:0.3192,fontSize:0.3362,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:0,lineHeight:0.86,boxW:0.2556}),
    t({text:'I',x:0.3946,y:0.5095,fontSize:0.3362,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:0,lineHeight:0.86,boxW:0.0866}),
    t({text:'S',x:0.4576,y:0.6998,fontSize:0.3362,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:0,lineHeight:0.86,boxW:0.2126}),
    t({text:'E',x:0.4504,y:0.8902,fontSize:0.3362,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:0,lineHeight:0.86,boxW:0.198}),
    t({text:'Talks on sound and the city\n12–14 October 2026\nKunsthalle, Hall 2',x:0.2441,y:0.0702,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.2441,y:0.9645,fontSize:0.0268,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Date as hero', bg:'#f2f0ef', layers:()=>[
    t({text:'12–14\nOctober\n2026',x:0.5,y:0.7134,fontSize:0.2874,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9318}),
    t({text:'NOISE',x:0.1803,y:0.0508,fontSize:0.1077,fontFamily:'Inter Tight',fontWeight:800,color:'#dd2200',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.2924}),
    t({text:'Talks on sound and the city\nKunsthalle, Hall 2',x:0.7559,y:0.0548,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'right',letterSpacing:0,lineHeight:1.28,boxW:0.42}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.2441,y:0.1225,fontSize:0.0268,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]},
  { name:'Interleave', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.5,y:0.1154,fontSize:0.3,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'justify',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9318}),
    t({text:'Talksonsoundandthecity',x:0.5,y:0.236,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.9318}),
    t({text:'NOISE',x:0.5,y:0.3534,fontSize:0.3,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9318}),
    t({text:'12–14October2026',x:0.5,y:0.4739,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.9318}),
    t({text:'NOISE',x:0.5,y:0.5913,fontSize:0.3,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'justify',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9318}),
    t({text:'Kunsthalle,Hall2',x:0.5,y:0.7118,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.9318}),
    t({text:'NOISE',x:0.5,y:0.8292,fontSize:0.3,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:-0.045,lineHeight:0.86,boxW:0.9318}),
    t({text:'Freeentry·noise.kunsthalle.org',x:0.5,y:0.9498,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.9318})
  ]},
  { name:'Spread', bg:'#f2f0ef', layers:()=>[
    t({text:'NOISE',x:0.5592,y:0.8993,fontSize:0.1558,fontFamily:'Inter Tight',fontWeight:800,color:'#121212',align:'left',letterSpacing:0.76,lineHeight:0.86,boxW:1.0503}),
    t({text:'Talks on sound and the city',x:0.178,y:0.0548,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#dd2200',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.2879}),
    t({text:'12–14 October 2026',x:0.4886,y:0.0548,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.2879}),
    t({text:'Kunsthalle, Hall 2',x:0.7992,y:0.0395,fontSize:0.0339,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'left',letterSpacing:0,lineHeight:1.28,boxW:0.2879}),
    t({text:'Free entry · noise.kunsthalle.org',x:0.7559,y:0.0355,fontSize:0.0268,fontFamily:'Inter Tight',fontWeight:500,color:'#121212',align:'right',letterSpacing:0.01,lineHeight:1.2,boxW:0.42})
  ]}
]
