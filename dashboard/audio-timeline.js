import { pcmScale } from './session.js';

// Sequence/sample counters identify actual missing acquisition data, independent
// of notification arrival bursts and the visual waveform's amplitude.
export function audioIntegrity(frames) {
  let missingFrames=0,missingSamples=0,missingMs=0,captureDrops=0,discontinuities=0;
  for(let i=1;i<frames.length;i++) {
    const a=frames[i-1],b=frames[i];
    if(a.stream_id!==b.stream_id) {discontinuities++;continue;}
    if(Number.isFinite(a.dropped)&&Number.isFinite(b.dropped))captureDrops+=Math.max(0,b.dropped-a.dropped);
    if(Number.isSafeInteger(a.sequence)&&Number.isSafeInteger(b.sequence)&&b.sequence>a.sequence)missingFrames+=b.sequence-a.sequence-1;
    if(a.segment!==b.segment || a.rate!==b.rate) {discontinuities++;continue;}
    if(Number.isSafeInteger(a.sample_index)&&Number.isSafeInteger(b.sample_index)&&b.sample_index>a.sample_index) {
      const lost=Math.max(0,b.sample_index-a.sample_index-a.pcm.length);
      missingSamples+=lost;missingMs+=lost*1000/a.rate;
    } else {
      const gap=b.time_ms-a.time_ms-a.pcm.length*1000/a.rate;
      if(gap>1)missingMs+=gap; // legacy files without sample counters
    }
  }
  return {missingFrames,missingSamples,missingMs,captureDrops,discontinuities};
}

// Empty columns stay empty. Both live acquisition and Data Explorer use sample
// timestamps, rather than concatenating received frames across a missing interval.
export function audioEnvelope(frames,start,end,columns) {
  const low=new Float32Array(columns).fill(Infinity),high=new Float32Array(columns).fill(-Infinity);
  let minimum=Infinity,maximum=-Infinity;
  for(const frame of frames) {
    const from=Math.max(0,Math.ceil((start-frame.time_ms)*frame.rate/1000));
    const to=Math.min(frame.pcm.length,Math.ceil((end-frame.time_ms)*frame.rate/1000));
    const scale=pcmScale(frame);
    for(let i=from;i<to;i++) {
      const column=Math.floor((frame.time_ms-start+i*1000/frame.rate)*columns/(end-start));
      if(column<0 || column>=columns)continue;
      const value=frame.pcm[i]/scale;
      low[column]=Math.min(low[column],value);high[column]=Math.max(high[column],value);
      minimum=Math.min(minimum,value);maximum=Math.max(maximum,value);
    }
  }
  return {low,high,minimum,maximum};
}
