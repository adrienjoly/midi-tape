let ppq = 24;
let bpm = 110;
let tickRate = 60000 / (bpm * ppq);

function tick() {
  postMessage({});
  setTimeout(tick, tickRate);
}

tick();

onmessage = function (e) {
  ppq = e.data.ppq;
  bpm = e.data.bpm;
  tickRate = 60000 / (bpm * ppq);
};
