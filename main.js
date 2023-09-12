// I wrote this code for fun over a weekend.
// Don't judge it too harshly.
// I mean I can't stop you.
// But you'll have to live with yourself.

// Settings.
let playing = false;
let recording = false;
let quantize = false;
let midiReady = false;
let metronome = true;
let countIn = false;
let replace = false;

// Used for recording/playback.
let currentTrack = 0;
let step = 0;
let startMarker = 0;
let endMarker = 0;
let countInTimer = 0;
let timer = new Worker("timer.js");
let alreadyWiped = {};
let notesHeld = {};
let playInput = false;
let quantizeLevel = 2;
let quantizeStrength = 100;
let justQuantized = {};
let justNoteOn = {};
let soloing = false;

// Used for user interactions.
let keysPressed = {};
let arrowTrackChange = false;
let arrowBeatChange = false;
let arrowQuantizeChange = false;
let deleteTrackChange = false;
let lockTape = true;
let spinTimeout;
let maxStep = 0;
let beatWidth = 25;
let debounceRenderSegments = debounce(renderSegments, 100);
let audioContext;
let microphone;
let monitor = false;
let recordAudio = false;
let mediaRecorder;
let audioChunks = [];
let lockKeyboard = false;

// A tape is data that should persist.
let defaultOutputDevice = 0;
let defaultOuputDeviceName = "Dummy Synth";
let defaultOutputChannel = 1;
let tape = {
  version: 5,
  ppq: 24,
  bpm: 110,
  inputDevice: 0,
  inputDeviceName: "Dummy Keyboard",
  name: "midi-tape",
  bpb: 4,
  tracks: [],
};
addTrack();
addTrack();
addTrack();
addTrack();
let tapeUndo = [];
let tapeRedo = [];

// Fake MIDI devices for ease of development.

let pitchShifter = new Tone.PitchShift(0).toDestination();
let synth = new Tone.PolySynth(Tone.Synth).toDestination();
synth.connect(pitchShifter);
let metronome_synth = new Tone.Synth({
  volume: -6,
}).toDestination();
metronome_synth.envelope.release = 0.1;
metronome_synth.envelope.attack = 0.005;
metronome_synth.envelope.decay = 0;
metronome_synth.envelope.sustain = 0.1;

let fakeOutput = {
  name: "Dummy Synth",
};

const tinySynth = JZZ.synth.Tiny()
  .or(function(){ alert('Cannot open MIDI-Out! ' + this.err()); });
tinySynth.ch(1).program(0);  // channel 1 <- piano
tinySynth.ch(2).program(32); // channel 2 <- bass
tinySynth.ch(3).program(40); // channel 3 <- violin
tinySynth.ch(4).program(55); // channel 4 <- trumpet

fakeOutput.playNote = async function (note_name, channel, options) {
  // synth.triggerAttack(note_name, Tone.context.currentTime, options.velocity ?? 1);
  console.log('playNote', {channel, note_name,...options})
  tinySynth.noteOn(channel, note_name, options.velocity * 127);
};

fakeOutput.stopNote = function (note_name, channel) {
  if (note_name === "all") {
    // synth.releaseAll();    
    tinySynth.allSoundOff(channel)
  } else {
    // synth.triggerRelease(note_name);
    tinySynth.noteOff(channel, note_name);
  }
};

fakeOutput.sendPitchBend = function (value, channel) {
  pitchShifter.pitch = value;
};

fakeOutput.sendControlChange = function (name, value) {};

fakeOutput.sendClock = function () {};

let fakeInput = {
  name: "Dummy Keyboard",
  id: "dummy_keyboard",
  keysHeld: {},
  octave: 4,
};

fakeInput.removeListener = function (type, channel, listener) {};

fakeInput.addListener = function (type, channel, listener) {};

fakeInput.getNoteForKey = function (key) {
  switch (key) {
    case "a":
      return "C";
    case "s":
      return "D";
    case "d":
      return "E";
    case "f":
      return "F";
    case "g":
      return "G";
    case "h":
      return "A";
    case "j":
      return "B";
  }
  return "C";
};

fakeInput.handleKeyUp = function (key) {
  if (key === "k" || key === "l") {
    // Release all held keys.
    for (let key in this.keysHeld) {
      let note = this.getNoteForKey(key);
      onNoteOff({
        target: {
          id: this.id,
        },
        velocity: 1,
        note: {
          octave: this.octave,
          name: note,
        },
      });
    }
    this.keysHeld = {};
    this.octave += key === "k" ? -1 : 1;
    return;
  }
  delete this.keysHeld[key];
  note = this.getNoteForKey(key);
  onNoteOff({
    target: {
      id: this.id,
    },
    note: {
      octave: this.octave,
      name: note,
    },
  });
};

fakeInput.handleKeyDown = function (key) {
  if (key === "k" || key === "l" || key in this.keysHeld) {
    return;
  }
  this.keysHeld[key] = true;
  note = this.getNoteForKey(key);
  onNoteOn({
    target: {
      id: this.id,
    },
    velocity: 1,
    note: {
      octave: this.octave,
      name: note,
    },
  });
};

// Main callback for outputting MIDI.

function wipeStepData() {
  let didWipe = false;
  if (
    !("noteOn" in alreadyWiped) &&
    typeof tape.tracks[currentTrack].noteOn[step] !== "undefined"
  ) {
    delete tape.tracks[currentTrack].noteOn[step];
    didWipe = true;
  }
  if (
    !("noteOff" in alreadyWiped) &&
    typeof tape.tracks[currentTrack].noteOff[step] !== "undefined"
  ) {
    delete tape.tracks[currentTrack].noteOff[step];
    didWipe = true;
    addTrackData(
      step,
      "noteOff",
      getUnfinishedNotes().filter((note) => !note in notesHeld)
    );
  }
  if (
    !("pitchbend" in alreadyWiped) &&
    typeof tape.tracks[currentTrack].pitchbend[step] !== "undefined"
  ) {
    delete tape.tracks[currentTrack].pitchbend[step];
    didWipe = true;
  }
  if (
    !("controlchange" in alreadyWiped) &&
    typeof tape.tracks[currentTrack].controlchange[step] !== "undefined"
  ) {
    delete tape.tracks[currentTrack].controlchange[step];
    didWipe = true;
  }
  alreadyWiped = {};
  if (didWipe) {
    renderSegments();
  }
}

function inputDeviceStart() {
  input = getInputDevice();
  getOutputs().forEach(function (output) {
    if (output.name === input.name) {
      output.sendStart();
    }
  });
}

function inputDeviceStop() {
  input = getInputDevice();
  getOutputs().forEach(function (output) {
    if (output.name === input.name) {
      output.sendStop();
    }
  });
}

function playMetronome(currentStep) {
  if (currentStep % (tape.ppq * tape.bpb) === 0) {
    metronome_synth.triggerAttackRelease("C4", 0.05, Tone.context.currentTime, 0.9);
  } else if (currentStep % tape.ppq === 0) {
    metronome_synth.triggerAttackRelease("C3", 0.05, Tone.context.currentTime, 0.9);
  }
}

function tick() {
  if (!playing) {
    return;
  }
  if (countInTimer > 0) {
    playMetronome(countInTimer);
    setTimeout(renderTimeline, 0);
    if (countInTimer % (tape.ppq / 24) === 0) {
      getOutputs().forEach(function (output) {
        output.sendClock();
      });
    }
    countInTimer--;
    return;
  }
  if (recording && replace) {
    wipeStepData();
  }
  if (playInput) {
    inputDeviceStart();
    playInput = false;
  }
  tape.tracks.forEach(function (track, trackNumber) {
    if (soloing && trackNumber !== currentTrack) {
      return;
    }
    if (typeof track.noteOn[step] !== "undefined") {
      for (let note in track.noteOn[step]) {
        if (
          trackNumber === currentTrack &&
          (note in notesHeld || note in justQuantized)
        ) {
          continue;
        }
        justNoteOn[trackNumber + ":" + note] = true;
        getOutputDevice(trackNumber).playNote(note, track.outputChannel, {
          velocity: track.noteOn[step][note],
        });
      }
    }
    if (typeof track.noteOff[step] !== "undefined") {
      track.noteOff[step].forEach(function (note) {
        if (trackNumber === currentTrack && note in justQuantized) {
          delete justQuantized[note];
          return;
        }
        delete justNoteOn[trackNumber + ":" + note];
        getOutputDevice(trackNumber).stopNote(note, track.outputChannel);
      });
    }
    if (typeof track.pitchbend[step] !== "undefined") {
      getOutputDevice(trackNumber).sendPitchBend(
        track.pitchbend[step],
        track.outputChannel
      );
    }
    if (typeof track.controlchange[step] !== "undefined") {
      for (let name in track.controlchange[step]) {
        try {
          getOutputDevice(trackNumber).sendControlChange(
            name,
            track.controlchange[step][name],
            track.outputChannel
          );
        } catch (e) {}
      }
    }
  });
  if (metronome) {
    playMetronome(step);
  }
  if (step % (tape.ppq / 24) === 0) {
    getOutputs().forEach(function (output) {
      output.sendClock();
    });
  }
  step++;
  if (endMarker !== 0 && endMarker <= step) {
    stopAllNotes();
    step = startMarker;
  }
  if (recordAudio && step > maxStep + tape.ppq * tape.bpb) {
    if (mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    stop();
    lockKeyboard = false;
  }
  setTimeout(renderTimeline, 0);
}

function getInputs() {
  return WebMidi.inputs.concat([fakeInput]);
}

function getInputDevice() {
  let i = tape.inputDevice;
  if (i >= getInputs().length) {
    i = 0;
  }
  return getInputs()[i];
}

function getOutputs() {
  return WebMidi.outputs.concat([fakeOutput]);
}

function getOutputDevice(trackNumber) {
  let i = tape.tracks[trackNumber].outputDevice;
  if (i >= getOutputs().length) {
    i = 0;
  }
  return getOutputs()[i];
}

function quantizeStep(setStep, multiple, mode) {
  if (mode === "ceil") {
    return Math.ceil(setStep / multiple) * multiple;
  } else if (mode === "floor") {
    return Math.floor(setStep / multiple) * multiple;
  } else {
    newStep = setStep + multiple / 2;
    newStep = newStep - (newStep % multiple);
    return newStep;
  }
}

function addTrack() {
  tape.tracks.push({
    outputDevice: defaultOutputDevice,
    outputDeviceName: defaultOuputDeviceName,
    outputChannel: defaultOutputChannel,
    noteOn: {},
    noteOff: {},
    pitchbend: {},
    controlchange: {},
  });
}

function removeTrack(track_number) {
  pushUndo();
  tape.tracks.splice(track_number, 1);
  currentTrack = track_number - 1;
  calculateMaxStep();
}

function addTrackData(setStep, property, data) {
  if (data == false) {
    return;
  }
  if (replace) {
    delete tape.tracks[currentTrack][property][setStep];
    alreadyWiped[property] = true;
  }
  if (Array.isArray(data)) {
    if (typeof tape.tracks[currentTrack][property][setStep] === "undefined") {
      tape.tracks[currentTrack][property][setStep] = [];
    }
    tape.tracks[currentTrack][property][setStep] = Array.from(
      new Set(tape.tracks[currentTrack][property][setStep].concat(data))
    );
  } else if (typeof data === "object") {
    if (typeof tape.tracks[currentTrack][property][setStep] === "undefined") {
      tape.tracks[currentTrack][property][setStep] = {};
    }
    for (let note in data) {
      tape.tracks[currentTrack][property][setStep][note] = data[note];
    }
  } else {
    tape.tracks[currentTrack][property][setStep] = data;
  }
}

/**
 * Populates track.outputDevice based on track.outputDeviceName
 * and tape.inputDevice based on tape.inputDeviceName.
 */
function setDevicesByName() {
  const outputs = getOutputs();
  for (const track of tape.tracks) {
    track.outputDevice = outputs.findIndex(output => output.name === track.outputDeviceName)
  }
  tape.inputDevice = getInputs().findIndex(input => input.name === tape.inputDeviceName)
}

function migrateTape(tape) {
  if (tape.version === 1 && typeof tape.name === "undefined") {
    tape.name = "midi-tape";
    tape.version = 2;
  }
  if (tape.version === 2) {
    if (typeof tape.inputDeviceName === "undefined") {
      tape.inputDeviceName = "";
    }
    tape.tracks.forEach(function (track) {
      if (typeof track.outputDeviceName === "undefined") {
        track.outputDeviceName = "";
      }
    });
    tape.version = 3;
  }
  if (tape.version === 3 && typeof tape.bpb === "undefined") {
    tape.bpb = 4;
  }
}

function debounce(func, wait, immediate) {
  let timeout;
  return function () {
    let context = this,
      args = arguments;
    let later = function () {
      timeout = null;
      if (!immediate) func.apply(context, args);
    };
    let callNow = immediate && !timeout;
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    if (callNow) func.apply(context, args);
  };
}

// MIDI input callbacks.

function onNoteOn(event) {
  if (getInputDevice().id !== event.target.id) {
    return;
  }
  let note = event.note.name + event.note.octave;
  if (playing && recording && countInTimer <= 0) {
    setStep = step;
    if (quantize) {
      setStep = quantizeStep(setStep, tape.ppq / quantizeLevel);
      let difference = Math.round((setStep - step) * (quantizeStrength / 100));
      setStep = step + difference;
      justQuantized[note] = [step, setStep];
    }
    addTrackData(setStep, "noteOn", {
      [note]: event.velocity,
    });
    notesHeld[note] = true;
    debounceRenderSegments();
  }
  justNoteOn[currentTrack + ":" + note] = true;
  getOutputDevice(currentTrack).playNote(
    note,
    tape.tracks[currentTrack].outputChannel,
    {
      velocity: event.velocity,
    }
  );
}

function onNoteOff(event) {
  if (getInputDevice().id !== event.target.id) {
    return;
  }
  let note = event.note.name + event.note.octave;
  if (playing && recording && countInTimer <= 0) {
    setStep = step;
    // Note lengths are not quantized, we only shift the note off events by the
    // same amount as the note on events.
    if (quantize && note in justQuantized) {
      let diff = justQuantized[note][1] - justQuantized[note][0];
      setStep += diff;
      // tick() will delete future note offs for us.
      if (setStep <= step) {
        delete justQuantized[note];
      }
    }
    addTrackData(setStep, "noteOff", [note]);
    delete notesHeld[note];
    debounceRenderSegments();
  }
  delete justNoteOn[currentTrack + ":" + note];
  getOutputDevice(currentTrack).stopNote(
    note,
    tape.tracks[currentTrack].outputChannel
  );
}

function onPitchBend(event) {
  if (getInputDevice().id !== event.target.id) {
    return;
  }
  if (playing && recording && countInTimer <= 0) {
    addTrackData(step, "pitchbend", event.value);
    debounceRenderSegments();
  }
  getOutputDevice(currentTrack).sendPitchBend(
    event.value,
    tape.tracks[currentTrack].outputChannel
  );
}

function onControlChange(event) {
  if (getInputDevice().id !== event.target.id) {
    return;
  }
  if (playing && recording && countInTimer <= 0) {
    addTrackData(step, "controlchange", {
      [event.controller.name]: event.value,
    });
    debounceRenderSegments();
  }
  try {
    getOutputDevice(currentTrack).sendControlChange(
      event.controller.name,
      event.value,
      tape.tracks[currentTrack].outputChannel
    );
  } catch (e) {}
}

// Keyboard interaction and callbacks.

function getUnfinishedNotes() {
  let noteCount = {};
  for (let i in tape.tracks[currentTrack].noteOn) {
    for (let note in tape.tracks[currentTrack].noteOn[i]) {
      if (!(note in noteCount)) {
        noteCount[note] = 1;
      } else {
        noteCount[note]++;
      }
    }
  }
  for (let i in tape.tracks[currentTrack].noteOff) {
    tape.tracks[currentTrack].noteOff[i].forEach(function (note) {
      if (note in noteCount) {
        noteCount[note]--;
        if (noteCount[note] <= 0) {
          delete noteCount[note];
        }
      }
    });
  }
  return Object.keys(noteCount);
}

function enableWebAudio() {
  Tone.start();
  document.getElementById("webaudio_button").remove();
}

function stopAllNotes() {
  getOutputs().forEach(function (output) {
    output.stopNote("all");
  });
  tape.tracks.forEach(function (track, trackNumber) {
    getOutputDevice(trackNumber).sendPitchBend(0);
  });
  for (let key in justNoteOn) {
    let parts = key.split(":");
    getOutputDevice(parts[0]).stopNote(parts[1]);
  }
  justNoteOn = {};
}

function togglePlay() {
  playing = !playing;
  justQuantized = {};
  if (!playing) {
    notesHeld = {};
    playInput = false;
    soloing = false;
    inputDeviceStop();
    addTrackData(step, "noteOff", getUnfinishedNotes());
    calculateMaxStep();
    renderSegments();
    renderTimeline();
  }
  if (countIn) {
    countInTimer = tape.ppq * tape.bpb;
  }
  stopAllNotes();
}

function toggleQuantize() {
  quantize = !quantize;
}

function toggleMetronome() {
  metronome = !metronome;
}

function stop() {
  playing = false;
  countInTimer = 0;
  notesHeld = {};
  justQuantized = {};
  playInput = false;
  inputDeviceStop();
  addTrackData(step, "noteOff", getUnfinishedNotes());
  debounceRenderSegments();
  if (step !== startMarker) {
    spinCassette(true);
  }
  step = startMarker;
  stopAllNotes();
  renderTimeline();
}

function toggleRecording() {
  recording = !recording;
  justQuantized = {};
  if (!recording) {
    notesHeld = {};
    addTrackData(step, "noteOff", getUnfinishedNotes());
    calculateMaxStep();
    debounceRenderSegments();
    renderTimeline();
  } else {
    pushUndo();
  }
}

function toggleReplace() {
  replace = !replace;
}

function changeTrack(track_number) {
  justQuantized = {};
  currentTrack =
    track_number < 0
      ? tape.tracks.length - 1
      : track_number % tape.tracks.length;
}

function addStartMarker() {
  if (playing) {
    return;
  }
  if (startMarker === step) {
    startMarker = 0;
    endMarker = 0;
  } else {
    startMarker = step;
  }
  if (startMarker >= endMarker) {
    endMarker = 0;
  }
}

function addEndMarker() {
  if (playing) {
    return;
  }
  if (endMarker === step || step === 0) {
    endMarker = 0;
  } else if (startMarker < step) {
    endMarker = step;
  } else if (startMarker >= step) {
    startMarker = 0;
    endMarker = step;
  }
}

function updateBpm(newBpm) {
  if (newBpm <= 0) {
    newBpm = 1;
  }
  tape.bpm = newBpm;
  timer.postMessage({ bpm: tape.bpm, ppq: tape.ppq });
  renderStatus();
}

function toggleCountIn() {
  countIn = !countIn;
  countInTimer = 0;
  renderStatus();
}

function deleteTrackData(pitch_cc_only) {
  if (endMarker > 0) {
    pushUndo();
    for (let i = startMarker; i < endMarker; ++i) {
      if (!pitch_cc_only) {
        if (typeof tape.tracks[currentTrack].noteOn[i] !== "undefined") {
          delete tape.tracks[currentTrack].noteOn[i];
        }
        if (typeof tape.tracks[currentTrack].noteOff[i] !== "undefined") {
          delete tape.tracks[currentTrack].noteOff[i];
        }
      }
      if (typeof tape.tracks[currentTrack].pitchbend[i] !== "undefined") {
        delete tape.tracks[currentTrack].pitchbend[i];
      }
      if (typeof tape.tracks[currentTrack].controlchange[i] !== "undefined") {
        delete tape.tracks[currentTrack].controlchange[i];
      }
    }
    stopAllNotes();
    addTrackData(startMarker, "noteOff", getUnfinishedNotes());
    renderSegments();
  }
}

function paste() {
  if (playing || endMarker === 0 || step === startMarker) {
    return;
  }
  pushUndo();
  if (replace) {
    let lastStep = endMarker - 1 - startMarker + step;
    for (let i = step; i <= lastStep; ++i) {
      delete tape.tracks[currentTrack].noteOn[i];
      delete tape.tracks[currentTrack].noteOff[i];
      delete tape.tracks[currentTrack].pitchbend[i];
      delete tape.tracks[currentTrack].controlchange[i];
    }
  }
  for (let i = startMarker; i < endMarker; ++i) {
    relativeStep = i - startMarker;
    pasteStep = relativeStep + step;
    if (typeof tape.tracks[currentTrack].noteOn[i] !== "undefined") {
      addTrackData(pasteStep, "noteOn", tape.tracks[currentTrack].noteOn[i]);
    }
    if (typeof tape.tracks[currentTrack].noteOff[i] !== "undefined") {
      addTrackData(pasteStep, "noteOff", tape.tracks[currentTrack].noteOff[i]);
    }
    if (typeof tape.tracks[currentTrack].pitchbend[i] !== "undefined") {
      addTrackData(
        pasteStep,
        "pitchbend",
        tape.tracks[currentTrack].pitchbend[i]
      );
    }
    if (typeof tape.tracks[currentTrack].controlchange[i] !== "undefined") {
      addTrackData(
        pasteStep,
        "controlchange",
        tape.tracks[currentTrack].controlchange[i]
      );
    }
  }
  addTrackData(
    step + (endMarker - startMarker),
    "noteOff",
    getUnfinishedNotes()
  );
  calculateMaxStep();
  renderSegments();
}

function storeTape() {
  localforage.setItem("tape", tape);
}

function wipeTape() {
  if (
    !confirm("Are you sure you want to permanently delete the current tape?")
  ) {
    return;
  }
  lockTape = true;
  localforage.clear().then(function () {
    location.reload();
  });
}

function save() {
  lockTape = true;
  let element = document.createElement("a");
  element.setAttribute(
    "href",
    "data:text/plain;charset=utf-8," +
      encodeURIComponent(JSON.stringify(tape, null, 2))
  );
  element.setAttribute("download", `${tape.name || "midi-tape"}.json`);
  element.style.display = "none";
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
  lockTape = false;
}

function load() {
  let input = document.createElement("input");
  input.type = "file";
  input.onchange = function (event) {
    let reader = new FileReader();
    reader.onload = function (event) {
      lockTape = true;
      tape = JSON.parse(event.target.result);
      migrateTape(tape);
      storeTape();
      location.reload();
    };
    reader.readAsText(event.target.files[0]);
  };
  input.click();
}

function spinCassette(backwards) {
  document.getElementById("cassette").classList = "";
  if (backwards) {
    setTimeout(
      () => (document.getElementById("cassette").classList = "spin-back")
    );
  } else {
    setTimeout(() => (document.getElementById("cassette").classList = "spin"));
  }
  if (spinTimeout) {
    clearTimeout(spinTimeout);
  }
  spinTimeout = setTimeout(
    () => (document.getElementById("cassette").classList = ""),
    500
  );
}

function nudgeCassette(backwards) {
  if (step <= 0) {
    return;
  }
  let reels = document.querySelectorAll(".reel-inner");
  reels.forEach(function (reel) {
    let rotation = parseInt(
      getComputedStyle(reel).getPropertyValue("--rotation")
    );
    rotation += backwards ? 10 : -10;
    reel.style = `--rotation: ${rotation}`;
  });
}

function getTrackFromKey(key) {
  let trackKey = false;
  if (/^[0-9]$/i.test(key)) {
    trackKey = parseInt(key);
    if (trackKey === 0) {
      trackKey = 9;
    } else if (!isNaN(trackKey)) {
      trackKey -= 1;
    } else {
      trackKey = false;
    }
  }
  return trackKey;
}

function getPressedTrackKey() {
  if ("o" in keysPressed) {
    return currentTrack;
  }
  let trackKey = false;
  for (let keyPressed in keysPressed) {
    trackKey = getTrackFromKey(keyPressed);
    if (trackKey !== false) {
      break;
    }
  }
  return trackKey;
}

function undo() {
  if (!tapeUndo.length) {
    return;
  }
  pushRedo();
  tape = JSON.parse(tapeUndo.pop());
  calculateMaxStep();
}

function redo() {
  if (!tapeRedo.length) {
    return;
  }
  pushUndo();
  tape = JSON.parse(tapeRedo.pop());
  calculateMaxStep();
}

function pushUndo() {
  tapeUndo.push(JSON.stringify(tape));
}

function pushRedo() {
  tapeRedo.push(JSON.stringify(tape));
}

function doToggleMonitor() {
  monitor = !monitor;
  if (monitor) {
    microphone.connect(audioContext.destination);
  } else {
    microphone.disconnect();
  }
  document.getElementById("monitor_button").innerText = monitor
    ? "Stop monitoring"
    : "Monitor audio";
  document.getElementById("record_button").disabled = !monitor;
}

function toggleMonitor() {
  if (!microphone) {
    if (
      !confirm(
        "Are you ready to monitor your browser's default input? If you're not wearing headphones and the default is your microphone, you could be in for a nasty feedback loop."
      )
    ) {
      return;
    }
    navigator.getUserMedia(
      {
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
        },
      },
      (stream) => {
        audioContext = new AudioContext();
        microphone = audioContext.createMediaStreamSource(stream);
        mediaRecorder = new MediaRecorder(stream, {
          mimeType: "audio/webm",
        });
        mediaRecorder.ondataavailable = (e) => {
          audioChunks.push(e.data);
        };
        mediaRecorder.onstop = onMediaRecorderStop;
        doToggleMonitor();
      },
      () => {
        alert("Error configuring microphone.");
      }
    );
  } else {
    doToggleMonitor();
  }
}

function onMediaRecorderStop() {
  if (!recordAudio) {
    return;
  }
  let blob = new Blob(audioChunks, { type: "audio/webm" });
  let audioURL = window.URL.createObjectURL(blob);

  let element = document.createElement("a");
  element.setAttribute("href", audioURL);
  element.setAttribute("download", `${tape.name || "midi-tape"}.webm`);
  element.style.display = "none";
  document.body.appendChild(element);
  element.click();
  document.body.removeElement(element);

  toggleRecordAudio();
}

function toggleRecordAudio() {
  recordAudio = !recordAudio;
  document.getElementById("record_button").innerText = recordAudio
    ? "Cancel recording"
    : "Record audio";
  step = 0;
  metronome = false;
  startMarker = 0;
  endMarker = 0;
  countIn = false;
  countInTimer = 0;
  recording = false;
  stop();
  if (recordAudio) {
    audioChunks = [];
    mediaRecorder.start();
    togglePlay();
    lockKeyboard = true;
  } else {
    if (mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
    lockKeyboard = false;
  }
  renderStatus();
}

function exportMidi() {
  let smf = new JZZ.MIDI.SMF(0, tape.ppq);

  calculateMaxStep();

  tape.tracks.forEach(function (track, trackNumber) {
    let trk = new JZZ.MIDI.SMF.MTrk();
    smf.push(trk);
    trk.add(0, JZZ.MIDI.smfBPM(tape.bpm));

    for (let i = 0; i <= maxStep; ++i) {
      let midiStep = i;
      if (typeof track.noteOn[i] !== "undefined") {
        for (let note in track.noteOn[i]) {
          trk.add(
            midiStep,
            JZZ.MIDI.noteOn(0, note, 127 * track.noteOn[i][note])
          );
        }
      }
      if (typeof track.noteOff[i] !== "undefined") {
        track.noteOff[i].forEach(function (note) {
          trk.add(midiStep, JZZ.MIDI.noteOff(0, note));
        });
      }
      if (typeof track.pitchbend[i] !== "undefined") {
        trk.add(midiStep, JZZ.MIDI.pitchBend(0, track.pitchbend[i]));
      }
      if (typeof track.controlchange[i] !== "undefined") {
        for (let name in track.controlchange[i]) {
          let controller = WebMidi.MIDI_CONTROL_CHANGE_MESSAGES[name];
          if (controller === undefined) {
            console.log(`Couldn't find controller for ${name}.`);
            continue;
          }
          trk.add(
            midiStep,
            JZZ.MIDI.control(0, controller, track.controlchange[i][name])
          );
        }
      }
    }
  });

  let element = document.createElement("a");
  midiUrl = "data:audio/midi;base64," + btoa(smf.dump());
  element.setAttribute("href", midiUrl);
  element.setAttribute("download", `${tape.name || "midi-tape"}.mid`);
  element.style.display = "none";
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
}

document.addEventListener("keydown", (event) => {
  if (event.target.id === "tape-name" || !midiReady || lockKeyboard) {
    return;
  }
  keysPressed[event.key] = true;
  let trackKey = getPressedTrackKey();
  let arrowBeatChange = "m" in keysPressed || "M" in keysPressed;
  let arrowQuantizeChange = "q" in keysPressed || "Q" in keysPressed;
  switch (event.key) {
    case "Shift":
      toggleModifierShortcuts(true);
      break;
    case "ArrowRight":
      if (
        trackKey === false &&
        !arrowBeatChange &&
        !playing &&
        !arrowQuantizeChange
      ) {
        if ("Shift" in keysPressed) {
          step += 1;
          step = quantizeStep(step, tape.ppq * tape.bpb, "ceil");
          spinCassette();
        } else {
          step += 10;
          nudgeCassette();
        }
        renderTimeline();
      }
      break;
    case "ArrowLeft":
      if (
        trackKey === false &&
        !arrowBeatChange &&
        !playing &&
        !arrowQuantizeChange
      ) {
        if ("Shift" in keysPressed) {
          step -= 1;
          step = quantizeStep(step, tape.ppq * tape.bpb, "floor");
          spinCassette(true);
        } else {
          step -= 10;
          nudgeCassette(true);
        }
        if (step < 0) {
          step = 0;
        }
        renderTimeline();
      }
      break;
    case "ArrowUp":
    case "ArrowDown":
      event.preventDefault();
      break;
    case "a":
    case "s":
    case "d":
    case "f":
    case "g":
    case "h":
    case "j":
    case "k":
    case "l":
      if (getInputDevice().name === "Dummy Keyboard") {
        fakeInput.handleKeyDown(event.key);
      }
      break;
  }
});

document.addEventListener("keyup", function (event) {
  if (event.target.id === "tape-name") {
    tape.name = event.target.value;
    return;
  }
  if (!midiReady || lockKeyboard) {
    return;
  }
  delete keysPressed[event.key];
  delete keysPressed[event.key.toLowerCase()];
  delete keysPressed[event.key.toUpperCase()];
  let trackKey = getPressedTrackKey();
  let inputChange = false;
  let beatChange = false;
  let quantizeChange = false;
  if (trackKey === false) {
    if ("i" in keysPressed) {
      inputChange = true;
    } else if ("m" in keysPressed || "M" in keysPressed) {
      beatChange = true;
    } else if ("q" in keysPressed || "Q" in keysPressed) {
      quantizeChange = true;
    }
  }
  switch (event.key) {
    case "Shift":
      toggleModifierShortcuts(false);
      break;
    case "ArrowUp":
      if (trackKey !== false) {
        tape.tracks[trackKey].outputDevice++;
        if (tape.tracks[trackKey].outputDevice >= getOutputs().length) {
          tape.tracks[trackKey].outputDevice = 0;
        }
        tape.tracks[trackKey].outputDeviceName = getOutputDevice(trackKey).name;
        arrowTrackChange = true;
      } else if (inputChange) {
        tape.inputDevice++;
        if (tape.inputDevice >= getInputs().length) {
          tape.inputDevice = 0;
        }
        tape.inputDeviceName = getInputDevice().name;
      } else if (beatChange) {
        offset = 1;
        if ("Shift" in keysPressed || "M" in keysPressed) {
          offset = 10;
        }
        updateBpm(tape.bpm + offset);
        arrowBeatChange = true;
      } else if (quantizeChange) {
        quantizeLevel *= 2;
        if (quantizeLevel > 4) {
          quantizeLevel = 4;
        }
        arrowQuantizeChange = true;
      } else {
        changeTrack(currentTrack - 1);
      }
      break;
    case "ArrowDown":
      if (trackKey !== false) {
        tape.tracks[trackKey].outputDevice--;
        if (tape.tracks[trackKey].outputDevice < 0) {
          tape.tracks[trackKey].outputDevice = getOutputs().length - 1;
        }
        tape.tracks[trackKey].outputDeviceName = getOutputDevice(trackKey).name;
        arrowTrackChange = true;
      } else if (inputChange) {
        tape.inputDevice--;
        if (tape.inputDevice < 0) {
          tape.inputDevice = getInputs().length - 1;
        }
        tape.inputDeviceName = getInputDevice().name;
      } else if (beatChange) {
        offset = 1;
        if ("Shift" in keysPressed || "M" in keysPressed) {
          offset = 10;
        }
        updateBpm(tape.bpm - offset);
        arrowBeatChange = true;
      } else if (quantizeChange) {
        quantizeLevel /= 2;
        if (quantizeLevel < 1) {
          quantizeLevel = 1;
        }
        arrowQuantizeChange = true;
      } else {
        changeTrack((currentTrack += 1));
      }
      break;
    case "ArrowRight":
      if (trackKey !== false) {
        tape.tracks[trackKey].outputChannel++;
        if (tape.tracks[trackKey].outputChannel > 16) {
          tape.tracks[trackKey].outputChannel = 1;
        }
        arrowTrackChange = true;
      } else if (beatChange) {
        tape.bpb++;
        if (tape.bpb > 16) {
          tape.bpb = 2;
        }
        arrowBeatChange = true;
      } else if (quantizeChange) {
        let offset = 1;
        if ("Shift" in keysPressed || "Q" in keysPressed) {
          offset = 10;
        }
        quantizeStrength += offset;
        if (quantizeStrength > 100) {
          quantizeStrength = 100;
        }
        arrowQuantizeChange = true;
      }
      break;
    case "ArrowLeft":
      if (trackKey !== false) {
        tape.tracks[trackKey].outputChannel--;
        if (tape.tracks[trackKey].outputChannel <= 0) {
          tape.tracks[trackKey].outputChannel = 16;
        }
        arrowTrackChange = true;
      } else if (beatChange) {
        tape.bpb--;
        if (tape.bpb < 2) {
          tape.bpb = 16;
        }
        arrowBeatChange = true;
      } else if (quantizeChange) {
        let offset = 1;
        if ("Shift" in keysPressed || "Q" in keysPressed) {
          offset = 10;
        }
        quantizeStrength -= offset;
        if (quantizeStrength <= 0) {
          quantizeStrength = 1;
        }
        arrowQuantizeChange = true;
      }
      break;
    case "p":
      if ("i" in keysPressed) {
        playInput = true;
      } else if ("o" in keysPressed) {
        soloing = true;
      }
      togglePlay();
      break;
    case "P":
      stop();
      break;
    case "r":
      toggleRecording();
      break;
    case "R":
      toggleReplace();
      break;
    case "m":
      if (!arrowBeatChange) {
        toggleMetronome();
      }
      arrowBeatChange = false;
      break;
    case "M":
      if (!arrowBeatChange) {
        toggleCountIn();
      }
      arrowBeatChange = false;
      break;
    case "q":
      if (!arrowQuantizeChange) {
        toggleQuantize();
      }
      arrowQuantizeChange = false;
      break;
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7":
    case "8":
    case "9":
    case "0":
      if (!arrowTrackChange && !deleteTrackChange) {
        changeTrack(getTrackFromKey(event.key));
      }
      deleteTrackChange = false;
      arrowTrackChange = false;
      break;
    case "t":
      addStartMarker();
      break;
    case "y":
      addEndMarker();
      break;
    case "Backspace":
      if (trackKey) {
        if (!("o" in keysPressed)) {
          deleteTrackChange = true;
        }
        removeTrack(trackKey);
        renderSegments();
        renderTimeline();
        renderStatus();
      } else {
        deleteTrackData("Shift" in keysPressed);
        calculateMaxStep();
        renderTimeline();
      }
      break;
    case "v":
      paste();
      break;
    case "V":
      // 11th hour hack to avoid refactoring paste/addTrackData.
      currentTrackBackup = currentTrack;
      tape.tracks.forEach(function (track, index) {
        currentTrack = index;
        paste();
      });
      currentTrack = currentTrackBackup;
      break;
    case "a":
    case "s":
    case "d":
    case "f":
    case "g":
    case "h":
    case "j":
    case "k":
    case "l":
      if (getInputDevice().name === "Dummy Keyboard") {
        fakeInput.handleKeyUp(event.key);
      }
      break;
    case "u":
      undo();
      renderSegments();
      break;
    case "U":
      redo();
      renderSegments();
      break;
    case "O":
      addTrack();
      currentTrack = tape.tracks.length - 1;
      renderSegments();
      break;
  }
  renderStatus();
  renderTimeline();
});

// UI rendering.

function getStepPixelPosition(step) {
  return (step / tape.ppq) * beatWidth;
}

function toggleModifierShortcuts(on) {
  [...document.getElementsByClassName("shortcut-without-modifier")].forEach(elem => {elem.style.display = on ? "none" : "inline-block"});
  [...document.getElementsByClassName("shortcut-with-modifier")].forEach(elem => {elem.style.display = on ? "inline-block" : "none"});
}

function renderStatus() {
  document.body.classList = `${recording ? "recording" : ""} ${
    playing ? "playing" : ""
  }`;
  // @todo Add this back when Chrome doesn't cache recording icon.
  // document.getElementById("favicon").href = recording ? "favicon-recording.png" : "favicon.png";
  document.getElementById("bpm-status").innerText = tape.bpm + " BPM";
  document.getElementById("playing").innerText = playing ? "Playing" : "Paused";
  document.getElementById("recording").innerText = recording
    ? "Recording"
    : "Not recording";
  document.getElementById("replace").innerText = replace
    ? "Replace on"
    : "Replace off";
  document.getElementById("metronome").innerText = metronome
    ? "Metronome on"
    : "Metronome off";
  document.getElementById("bpb-status").innerText = tape.bpb + " BPB";
  document.getElementById("count-in").innerText = countIn
    ? "Count in on"
    : "Count in off";
  document.getElementById("quantized").innerText = quantize
    ? `Quantize on (1/${quantizeLevel * 4}) (${quantizeStrength}%)`
    : "Quantize off";
  document.querySelectorAll(".output-device").forEach((outputElem) => {
    outputElem.remove();
  });
  tape.tracks.forEach(function (track, index) {
    document.getElementById(`track_${index}`).classList =
      index === currentTrack ? "track current-track" : "track";
    let outputElem = document.createElement("div");
    outputElem.setAttribute("id", `output-device-${index}`);
    outputElem.setAttribute("class", "output-device");
    outputElem.innerHTML = `<b>Track ${
      index + 1
    }</b>&nbsp;&nbsp;&nbsp;<span></span>`;
    outputElem.children[1].innerText = `${getOutputDevice(index).name} (${
      track.outputChannel
    })`;
    document.getElementById("config").appendChild(outputElem);
  });
  document.getElementById(
    "input-device"
  ).innerHTML = `<b>Input</b>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span></span> <span class="hint">– <span class="key">i</span> + <span class="key">↑</span>/<span class="key">↓</span> to switch</span>`;
  document.getElementById(
    "input-device"
  ).children[1].innerText = getInputDevice().name;

  startMarkerPx = getStepPixelPosition(startMarker);
  endMarkerPx = getStepPixelPosition(endMarker);
  if (startMarker > 0) {
    document.getElementById("timeline-start-marker").style = `left: ${
      startMarkerPx - 1
    }px; display: block;`;
  } else {
    document.getElementById("timeline-start-marker").style = "";
  }
  if (endMarker > 0) {
    document.getElementById("timeline-end-marker").style = `left: ${
      endMarkerPx - 1
    }px; display: block;`;
    document.getElementById(
      "timeline-marker-bg"
    ).style = `left: ${startMarkerPx}px; width:${
      endMarkerPx - startMarkerPx
    }px;`;
  } else {
    document.getElementById("timeline-end-marker").style = "";
    document.getElementById("timeline-marker-bg").style = "display: none;";
  }
  document.getElementById("tape-name").value = tape.name;
}

function renderSegments() {
  document.querySelectorAll(".track").forEach((trackElem) => {
    trackElem.remove();
  });
  tape.tracks.forEach(function (track, track_number) {
    let trackElem = document.createElement("div");
    trackElem.setAttribute("id", `track_${track_number}`);
    trackElem.classList =
      track_number === currentTrack ? "track current-track" : "track";
    document.getElementById("timeline").appendChild(trackElem);
    let segments = [];
    let sortedNoteOff = Object.keys(track.noteOff)
      .map(Number)
      .sort((a, b) => a - b);
    for (let i of Object.keys(track.noteOn)
      .map(Number)
      .sort((a, b) => a - b)) {
      for (let j of sortedNoteOff) {
        if (j < i) {
          continue;
        }
        sharedNotes = track.noteOff[j].filter(
          (note) => note in track.noteOn[i]
        );
        if (sharedNotes.length > 0) {
          segments.push({
            firstStep: i,
            lastStep: j,
          });
          break;
        }
      }
    }
    segments.forEach(function (segment) {
      let segmentElem = document.createElement("div");
      segmentElem.classList = "timeline-segment";
      left = getStepPixelPosition(segment.firstStep);
      width = getStepPixelPosition(segment.lastStep) - left;
      segmentElem.style = `left: ${left}px; width: ${width}px`;
      trackElem.append(segmentElem);
    });

    for (let i in track.pitchbend) {
      let pitchElem = document.createElement("div");
      pitchElem.classList = "timeline-pitchbend";
      left = getStepPixelPosition(i);
      pitchElem.style = `left: ${left}px;`;
      trackElem.append(pitchElem);
    }

    for (let i in track.controlchange) {
      let pitchElem = document.createElement("div");
      pitchElem.classList = "timeline-controlchange";
      left = getStepPixelPosition(i);
      pitchElem.style = `left: ${left}px;`;
      trackElem.append(pitchElem);
    }
  });
}

function renderTimeline() {
  let backgroundSize = tape.bpb * beatWidth;
  // Hack to fix subpixel rendering for Macs.
  let extraStyle = "";
  if (tape.bpb <= 3) {
    extraStyle =
      "background: linear-gradient(90deg, #dedede 2%, transparent 2%) 1px 0, #1e1e1e;";
  }
  let timelinePosition = getStepPixelPosition(step);
  document.getElementById(
    "timeline"
  ).style = `${extraStyle} transform: translateX(-${timelinePosition}px); width: calc(100% + ${timelinePosition}px); background-size: ${backgroundSize}px 1px;`;
  let counterText = String(Math.floor(step / tape.ppq)).padStart(4, "0");
  document.getElementById("counter").dataset.count = counterText;
  let renderMaxStep = maxStep;
  if (renderMaxStep <= 0) {
    scale = 0;
  } else {
    scale = step / renderMaxStep;
  }
  if (scale > 1) {
    scale = 1;
  }
  document.getElementById("reel-tape-right").style = `transform: scale(${
    0.3 + scale * 0.7
  });`;
  document.getElementById("reel-tape-left").style = `transform: scale(${
    1 - scale * 0.7
  });`;
}

function calculateMaxStep() {
  maxStep = 0;
  tape.tracks.forEach(function (track) {
    let allNotes = Object.keys(track.noteOff)
      .concat(Object.keys(track.noteOn))
      .concat(Object.keys(track.pitchbend))
      .concat(Object.keys(track.controlchange));
    let trackMax = Math.max(...allNotes.map(Number));
    if (trackMax > maxStep) {
      maxStep = trackMax;
    }
  });
}

// Init code.

document.addEventListener("visibilitychange", function () {
  keysPressed = {};
});

setInterval(function () {
  if (!lockTape) {
    storeTape();
  }
}, 500);

localforage.getItem("tape").then(function (value) {
  if (value) {
    console.log("Load local configuration:", value);
    tape = value;
    migrateTape(tape);
    renderSegments();
    updateBpm(tape.bpm);
    calculateMaxStep();
    if (midiReady) {
      setDevicesByName();
      renderTimeline();
      renderStatus();
    }
  }
  lockTape = false;
});

timer.onmessage = (event) => {
  tick();
};

function addInputListeners(input) {
  input.removeListener("noteon");
  input.removeListener("noteoff");
  input.removeListener("pitchbend");
  input.removeListener("controlchange");
  input.addListener("noteon", "all", onNoteOn);
  input.addListener("noteoff", "all", onNoteOff);
  input.addListener("pitchbend", "all", onPitchBend);
  input.addListener("controlchange", "all", onControlChange);
}

WebMidi.enable((err) => {
  midiReady = true;
  renderSegments();
  renderTimeline();
  renderStatus();
  WebMidi.inputs.forEach(function (input, key) {
    addInputListeners(input);
  });
  WebMidi.addListener("connected", function (e) {
    if (e.port.type === "input") {
      addInputListeners(e.port);
    }
    setDevicesByName();
    if (e.port.type === "input") {
      // switch current input to this one
      tape.inputDevice = 0
      tape.inputDeviceName = getInputs()[0].name;
    }
    renderStatus();
  });
  WebMidi.addListener("disconnected", function (e) {
    setDevicesByName();
    if (e.port.type === "input") {
      // switch current input back to its default
      tape.inputDevice = 0
      tape.inputDeviceName = getInputs()[0].name;
    }
    renderStatus();
  });
});
