document.addEventListener('DOMContentLoaded', () => {
    // Register the service worker for PWA functionality
    if ('serviceWorker' in navigator) {
        // Reload once when an updated service worker takes over, so the page runs
        // the newly deployed files. Skipped on first install (no previous controller).
        if (navigator.serviceWorker.controller) {
            let reloading = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                // Don't cut off playing noise; the update applies on the next launch
                if (reloading || isPlaying) return;
                reloading = true;
                window.location.reload();
            });
        }

        navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' })
            .then(registration => console.log('Service Worker registered with scope:', registration.scope))
            .catch(error => console.error('Service Worker registration failed:', error));
    }

    const noiseButtons = document.querySelectorAll('.noise-btn');
    const playPauseButton = document.getElementById('play-pause-btn');
    const volumeSlider = document.getElementById('volume-slider');
    const volumeValue = document.getElementById('volume-value');
    const statusText = document.getElementById('status-text');

    // Noise is pre-rendered into a looping WAV and played through <audio> elements
    // rather than streamed through the Web Audio API. On iOS this:
    //  - plays even when the ringer switch is set to silent (Web Audio is muted),
    //  - keeps playing when the screen locks or the app is backgrounded,
    //  - only needs a plain audio.play() inside the tap handler to start.
    const SAMPLE_RATE = 44100;
    const LOOP_SECONDS = 20;
    // Fraction of the loop, on each side of the loop point, where a voice is silent
    const SILENT_ZONE = 0.05;
    const DEFAULT_VOLUME = 0.7; // Slider position; 0.7² ≈ the previous fixed gain of 0.5
    const VOLUME_STORAGE_KEY = 'noisegen-volume';

    // Browsers leave a short silent gap (~100 ms) every time an <audio> element
    // loops. To hide it, two elements ("voices") play the same clip half a loop
    // apart. The clip is enveloped so each voice fades to silence around its own
    // loop point while the other is at full level; the envelopes are complementary,
    // so the combined loudness stays constant and the gaps fall where it's silent.
    const createVoice = () => {
        const voice = new Audio();
        voice.loop = true;
        voice.preload = 'auto';
        voice.setAttribute('playsinline', '');
        return voice;
    };
    const voices = [createVoice(), createVoice()];
    const [voiceA, voiceB] = voices;

    // iOS ignores writes to audio.volume (it always reads back as 1). There the
    // gain is baked into the WAV instead and the loop is re-encoded on change.
    const supportsVolume = (() => {
        const probe = new Audio();
        probe.volume = 0.5;
        return probe.volume === 0.5;
    })();

    const noiseSamples = {}; // Cache of rendered float samples per noise color
    const noiseUrls = {}; // Cache of generated WAV blob URLs per noise color
    let selectedNoise = null;
    let isPlaying = false;
    let isSwitching = false; // Set while sources change, to ignore the resulting pause events
    let volume = DEFAULT_VOLUME;

    try {
        const stored = parseFloat(localStorage.getItem(VOLUME_STORAGE_KEY));
        if (stored >= 0 && stored <= 1) volume = stored;
    } catch (e) {
        // Storage unavailable (e.g. private mode); keep the default
    }

    // Squared curve so the slider feels roughly linear in perceived loudness
    const volumeToGain = (v) => v * v;

    const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

    // Returns a function producing successive samples of the given noise color.
    const createNoiseSource = (type) => {
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0; // Pink
        let lastOut = 0; // Brown
        let lastIn = 0; // Purple

        switch (type) {
            case 'white':
                return () => Math.random() * 2 - 1;
            case 'pink':
                return () => {
                    const white = Math.random() * 2 - 1;
                    b0 = 0.99886 * b0 + white * 0.0555179;
                    b1 = 0.99332 * b1 + white * 0.0750759;
                    b2 = 0.96900 * b2 + white * 0.1538520;
                    b3 = 0.86650 * b3 + white * 0.3104856;
                    b4 = 0.55000 * b4 + white * 0.5329522;
                    b5 = -0.7616 * b5 - white * 0.0168980;
                    const out = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
                    b6 = white * 0.115926;
                    return out;
                };
            case 'brown':
                return () => {
                    const white = Math.random() * 2 - 1;
                    lastOut = (lastOut + (0.02 * white)) / 1.02;
                    return lastOut * 3.5;
                };
            case 'purple':
                return () => {
                    const white = Math.random() * 2 - 1;
                    const out = white - lastIn;
                    lastIn = white;
                    return out * 0.7;
                };
            default:
                return () => 0;
        }
    };

    // Power envelope over the loop phase u in [0, 1): silent around the loop point
    // (u near 0 or 1), full around u = 0.5, with equal-power ramps in between.
    // envelope(u) + envelope(u + 0.5) === 1, so two voices half a loop apart sum
    // to constant power.
    const envelope = (u) => {
        const rampLength = 0.5 - 2 * SILENT_ZONE;
        const d = Math.abs(u - 0.5); // 0 at the center, 0.5 at the loop point
        if (d <= SILENT_ZONE) return 1;
        if (d >= 0.5 - SILENT_ZONE) return 0;
        return Math.cos((Math.PI / 2) * (d - SILENT_ZONE) / rampLength) ** 2;
    };

    // Renders LOOP_SECONDS of noise shaped by the voice envelope.
    const renderLoop = (type) => {
        const length = SAMPLE_RATE * LOOP_SECONDS;
        const next = createNoiseSource(type);

        // Run the filters for a moment first so brown/pink noise starts settled
        for (let i = 0; i < SAMPLE_RATE; i++) next();

        const samples = new Float32Array(length);
        for (let i = 0; i < length; i++) {
            samples[i] = next() * Math.sqrt(envelope(i / length));
        }
        return samples;
    };

    // Encodes mono float samples as a 16-bit PCM WAV blob, scaled by gain.
    const encodeWav = (samples, gain) => {
        const buffer = new ArrayBuffer(44 + samples.length * 2);
        const view = new DataView(buffer);
        const writeString = (offset, str) => {
            for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + samples.length * 2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true); // fmt chunk size
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, 1, true); // mono
        view.setUint32(24, SAMPLE_RATE, true);
        view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
        view.setUint16(32, 2, true); // block align
        view.setUint16(34, 16, true); // bits per sample
        writeString(36, 'data');
        view.setUint32(40, samples.length * 2, true);

        for (let i = 0; i < samples.length; i++) {
            const s = Math.max(-1, Math.min(1, samples[i])) * gain;
            view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        return new Blob([buffer], { type: 'audio/wav' });
    };

    const getNoiseUrl = (type) => {
        if (!noiseUrls[type]) {
            if (!noiseSamples[type]) {
                noiseSamples[type] = renderLoop(type);
            }
            const gain = supportsVolume ? 1 : volumeToGain(volume);
            noiseUrls[type] = URL.createObjectURL(encodeWav(noiseSamples[type], gain));
        }
        return noiseUrls[type];
    };

    const updateVolumeUi = () => {
        volumeValue.textContent = `${Math.round(volume * 100)}%`;
    };

    const applyVolume = (v, { final }) => {
        volume = v;
        updateVolumeUi();

        if (supportsVolume) {
            voices.forEach(voice => { voice.volume = volumeToGain(volume); });
        } else if (final) {
            // Re-encode at the new gain and resume from the same position
            Object.keys(noiseUrls).forEach(type => {
                URL.revokeObjectURL(noiseUrls[type]);
                delete noiseUrls[type];
            });
            if (selectedNoise) {
                const position = voiceA.currentTime;
                if (isPlaying) {
                    playNoise(position);
                } else {
                    loadVoices(getNoiseUrl(selectedNoise), position);
                }
            }
        }

        if (final) {
            try {
                localStorage.setItem(VOLUME_STORAGE_KEY, String(volume));
            } catch (e) {
                // Storage unavailable; the setting just won't persist
            }
        }
    };

    volumeSlider.value = Math.round(volume * 100);
    updateVolumeUi();
    if (supportsVolume) voices.forEach(voice => { voice.volume = volumeToGain(volume); });

    volumeSlider.addEventListener('input', () => applyVolume(volumeSlider.value / 100, { final: false }));
    volumeSlider.addEventListener('change', () => applyVolume(volumeSlider.value / 100, { final: true }));

    const updateUi = () => {
        playPauseButton.textContent = isPlaying ? 'Pause' : 'Play';
        if (selectedNoise) {
            statusText.textContent = isPlaying
                ? `Playing ${capitalize(selectedNoise)} Noise`
                : `${capitalize(selectedNoise)} Noise selected`;
        }
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
        }
    };

    // Seeks a voice once its metadata is available (seeking before that is ignored).
    const seekVoice = (voice, time) => {
        if (voice.readyState >= 1) {
            voice.currentTime = time;
        } else {
            voice.addEventListener('loadedmetadata', () => { voice.currentTime = time; }, { once: true });
        }
    };

    // Points both voices at the clip, voice B half a loop ahead of voice A.
    const loadVoices = (url, position) => {
        if (voiceA.src === url && position === undefined) return;
        const start = position || 0;
        voices.forEach(voice => {
            if (voice.src !== url) voice.src = url;
        });
        seekVoice(voiceA, start);
        seekVoice(voiceB, (start + LOOP_SECONDS / 2) % LOOP_SECONDS);
    };

    // Must be called synchronously from a user gesture (click) so iOS allows playback.
    // position optionally restarts both voices from a given point in the loop.
    const playNoise = (position) => {
        if (!selectedNoise) return;

        isSwitching = true;
        loadVoices(getNoiseUrl(selectedNoise), typeof position === 'number' ? position : undefined);

        if ('mediaSession' in navigator && window.MediaMetadata) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: `${capitalize(selectedNoise)} Noise`,
                artist: 'Noise Generator',
                artwork: [
                    { src: 'icons/web-app-manifest-512x512.png', sizes: '512x512', type: 'image/png' }
                ]
            });
        }

        Promise.all(voices.map(voice => voice.play())).then(() => {
            isSwitching = false;
            isPlaying = true;
            updateUi();
        }).catch(error => {
            // A newer play() (e.g. quickly switching colors) superseded this one.
            if (error.name === 'AbortError') return;
            console.error('Playback failed:', error);
            isSwitching = false;
            voices.forEach(voice => voice.pause());
            isPlaying = false;
            playPauseButton.textContent = 'Play';
            statusText.textContent = 'Could not start audio. Tap Play to try again.';
        });
    };

    const stopNoise = () => {
        isPlaying = false;
        voices.forEach(voice => voice.pause());
        updateUi();
    };

    // If either voice is paused externally (lock screen controls, headphones
    // unplugged, phone call, etc.), pause both and keep the UI in sync.
    voices.forEach(voice => {
        voice.addEventListener('pause', () => {
            if (isPlaying && !isSwitching) stopNoise();
        });
    });

    // Keep voice B half a loop away from voice A. Both lose the same gap on every
    // loop so they rarely drift, but if they do, correct B while it's silent.
    voiceA.addEventListener('timeupdate', () => {
        if (!isPlaying || isSwitching || voiceB.seeking) return;
        const expected = (voiceA.currentTime + LOOP_SECONDS / 2) % LOOP_SECONDS;
        let drift = voiceB.currentTime - expected;
        drift -= LOOP_SECONDS * Math.round(drift / LOOP_SECONDS);
        const phaseB = voiceB.currentTime / LOOP_SECONDS;
        const bIsSilent = phaseB < SILENT_ZONE * 0.8 || phaseB > 1 - SILENT_ZONE * 0.8;
        if (Math.abs(drift) > 0.25 && bIsSilent) {
            voiceB.currentTime = expected;
        }
    });

    if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', playNoise);
        navigator.mediaSession.setActionHandler('pause', stopNoise);
    }

    noiseButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            e.preventDefault();

            noiseButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            const newNoise = button.dataset.noise;
            if (selectedNoise !== newNoise) {
                selectedNoise = newNoise;
                if (isPlaying) {
                    // Switch the noise type immediately
                    playNoise();
                } else {
                    // Render ahead of time so pressing Play starts instantly
                    getNoiseUrl(selectedNoise);
                    updateUi();
                }
            }

            playPauseButton.disabled = false;
        });
    });

    playPauseButton.addEventListener('click', (e) => {
        e.preventDefault();
        if (!selectedNoise) return;

        if (isPlaying) {
            stopNoise();
        } else {
            playNoise();
        }
    });
});
