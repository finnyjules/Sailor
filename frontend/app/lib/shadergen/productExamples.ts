/**
 * The two fixed examples every product shader-generation request carries (spec §7.2): two spike
 * takes that met the quality bar — rain take 3 ("Fogged glass", reads the picture) and ink take 4
 * ("Suminagashi", standalone) — with their look and dials kept and their motion REWRITTEN to the
 * loop rule (2026-09-26). The spike versions drive motion from raw u_time, so as examples they
 * taught the opposite of what the checks require. Here every moving value comes from loopPhase()
 * in whole cycles: each per-feature rate is a whole number of the loop, and the Speed dial is the
 * whole number of cycles per loop (rounded, at least 1).
 *
 * The spike fixture (`__eval__/spikeTakes.ts`) is left as it was: it is generated from the spike
 * page and the evaluation page still shows it. Both takes pass the real checks, including the loop
 * check, in the browser renderer (tests/shader-gen-examples.spec.ts) and the static check
 * (tests/unit/shadergen-product-examples.unit.spec.ts).
 */
import type { GenTake } from '~~/shared/shadergen/contract'

export interface ProductExample { name: string; request: string; take: GenTake }

/** Rain take 3, over the picture: fog and frost blur the glass, beads of condensation lens it, and
 *  drops run down clearing a trail. Each column's drop falls a whole number of times per loop
 *  (Speed, doubled for a quarter of the columns); its cleared trail fogs over before the next fall. */
export const FOGGED_GLASS: GenTake = {
  name: 'Fogged glass',
  animated: true,
  generative: false,
  params: [
    { uniform: 'u_fog', label: 'Fog', type: 'float', min: 0, max: 1, step: 0.01, default: 0.8 },
    { uniform: 'u_frost', label: 'Frost', type: 'float', min: 0, max: 1, step: 0.01, default: 0.5 },
    { uniform: 'u_drops', label: 'Drops', type: 'float', min: 0, max: 1, step: 0.01, default: 0.4 },
    { uniform: 'u_speed', label: 'Speed', type: 'float', min: 1, max: 3, step: 1, default: 1 },
  ],
  body: `uniform float u_fog; uniform float u_frost; uniform float u_drops; uniform float u_speed;
void main(){
  vec2 uv=v_texCoord; vec2 asp=ASP();
  vec2 fn=vec2(fbm(uv*asp*40.0+u_seed), fbm(uv*asp*40.0+17.0))-0.5;
  vec3 fogc=blur9(uv+fn*0.02*u_frost, 0.012*u_fog);
  fogc=mix(fogc, vec3(0.85,0.88,0.9), 0.25*u_fog);
  float cols=4.0+u_drops*20.0;
  float cx=uv.x*asp.x*cols; float id=floor(cx); float fx=fract(cx)-0.5;
  float n=h21(vec2(id,u_seed));
  float clear=0.0; float dm=0.0; vec2 doff=vec2(0.0);
  if(n<0.5+u_drops*0.4){
    float xo=(h21(vec2(id,3.0))-0.5)*0.5 + sin(uv.y*18.0+n*20.0)*0.08;
    // Whole falls per loop: Speed's count, twice that for a quarter of the columns.
    float falls=max(1.0,floor(u_speed+0.5))*(1.0+step(0.75,h21(vec2(id,7.0))));
    // Each fall starts just above the glass and ends below it; its trail fogs over before the next.
    float age=fract(loopPhase()*falls+n);
    float y=1.2-age*1.6;
    float w=abs(fx-xo);
    clear=smoothstep(0.18,0.05,w)*step(y,uv.y)*(1.0-smoothstep(y,y+0.8,uv.y)*0.6)*(1.0-smoothstep(0.6,1.0,age));
    vec2 dd=vec2(fx-xo,(uv.y-y)*cols*0.8);
    dm=smoothstep(0.3,0.22,length(dd)); doff=dd;
  }
  vec2 g=uv*asp*60.0; vec2 bid=floor(g); vec2 bf=fract(g)-0.5;
  vec2 bc=(vec2(h21(bid+u_seed),h21(bid+9.0))-0.5)*0.5;
  float br=0.15+0.2*h21(bid+4.0);
  float bm=smoothstep(br,br*0.6,length(bf-bc))*step(0.5,h21(bid+2.0))*(1.0-clear);
  vec3 col=mix(fogc, tex(uv), clear);
  col=mix(col, tex(uv-(bf-bc)*0.01), bm*0.8);
  col=mix(col, tex(uv-doff/(cols*asp)*2.0)*0.95, dm);
  fragColor0=vec4(clamp(col,0.0,1.0),1.0);
}`,
}

/** Ink take 4, standalone: suminagashi rings of ink floating on paper. The rings drift outward one
 *  ring spacing per cycle, the warp's noise goes round a small circle and the ripple runs one wave
 *  per cycle — Speed whole cycles per loop. */
export const SUMINAGASHI: GenTake = {
  name: 'Suminagashi',
  animated: true,
  generative: true,
  params: [
    { uniform: 'u_rings', label: 'Rings', type: 'float', min: 2, max: 30, step: 0.5, default: 12 },
    { uniform: 'u_warp', label: 'Warp', type: 'float', min: 0, max: 2, step: 0.01, default: 0.8 },
    { uniform: 'u_speed', label: 'Speed', type: 'float', min: 1, max: 3, step: 1, default: 1 },
    { uniform: 'u_ink', label: 'Ink', type: 'color', default: '#20242e' },
    { uniform: 'u_paper', label: 'Paper', type: 'color', default: '#efe8da' },
  ],
  body: `uniform float u_rings; uniform float u_warp; uniform float u_speed; uniform vec3 u_ink; uniform vec3 u_paper;
void main(){
  vec2 uv=v_texCoord; vec2 asp=ASP(); vec2 p=(uv-0.5)*asp;
  // Whole cycles per loop: Speed's count.
  float k=max(1.0,floor(u_speed+0.5));
  float ph=loopPhase()*k; float ang=6.28318*ph;
  vec2 drift=vec2(cos(ang),sin(ang))*0.12;
  p+=(vec2(fbm(p*2.0+drift), fbm(p*2.0+4.0-drift))-0.5)*u_warp*0.5;
  float a=atan(p.y,p.x); p+=vec2(cos(a),sin(a))*sin(length(p)*6.0-ang)*0.02*u_warp;
  float d=1e9;
  for(int i=0;i<3;i++){
    float fi=float(i);
    vec2 c=(vec2(h21(vec2(fi,u_seed+4.0)),h21(vec2(fi,u_seed+6.0)))-0.5)*0.6;
    d=min(d, length(p-c));
  }
  float band=abs(fract(d*u_rings-ph)-0.5)*2.0;
  float ink=1.0-smoothstep(0.25,0.4,band);
  vec3 col=mix(u_paper, u_ink, ink*0.85);
  col*=0.97+0.03*vnoise(uv*asp*300.0);
  fragColor0=vec4(col,1.0);
}`,
}

/** The spike requests they were written for (EVAL_REQUESTS' rain and ink), verbatim. */
export const PRODUCT_EXAMPLES: ProductExample[] = [
  { name: 'rain', request: 'Turn this into rain on a window', take: FOGGED_GLASS },
  { name: 'ink', request: 'Ink bleeding into wet paper', take: SUMINAGASHI },
]
