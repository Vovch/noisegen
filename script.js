document.addEventListener('DOMContentLoaded', () => {
    // Register the service worker for PWA functionality
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./service-worker.js')
            .then(registration => console.log('Service Worker registered with scope:', registration.scope))
            .catch(error => console.error('Service Worker registration failed:', error));
    }

    const noiseButtons = document.querySelectorAll('.noise-btn');
    const playPauseButton = document.getElementById('play-pause-btn');
    const statusText = document.getElementById('status-text');

    // Noise is pre-rendered into a seamlessly looping WAV and played through an
    // <audio> element rather than streamed through the Web Audio API. On iOS this:
    //  - plays even when the ringer switch is set to silent (Web Audio is muted),
    //  - keeps playing when the screen locks or the app is backgrounded,
    //  - only needs a plain audio.play() inside the tap handler to start.
    const SAMPLE_RATE = 44100;
    const LOOP_SECONDS = 20;
    const CROSSFADE_SECONDS = 0.5;
    const MASTER_GAIN = 0.5;

    const audio = new Audio();
    audio.loop = true;
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');

    const noiseUrls = {}; // Cache of generated WAV blob URLs per noise color
    let selectedNoise = null;
    let isPlaying = false;

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

    // Renders LOOP_SECONDS of noise whose end crossfades into its start, so the
    // <audio> loop point is inaudible.
    const renderLoop = (type) => {
        const length = SAMPLE_RATE * LOOP_SECONDS;
        const fade = Math.floor(SAMPLE_RATE * CROSSFADE_SECONDS);
        const next = createNoiseSource(type);

        const raw = new Float32Array(length + fade);
        for (let i = 0; i < raw.length; i++) {
            raw[i] = next();
        }

        const samples = raw.subarray(0, length);
        for (let i = 0; i < fade; i++) {
            const t = i / fade;
            // Equal-power crossfade: the tail rendered past the loop end fades out
            // while the head fades in.
            samples[i] = raw[i] * Math.sqrt(t) + raw[length + i] * Math.sqrt(1 - t);
        }
        return samples;
    };

    // Encodes mono float samples as a 16-bit PCM WAV blob.
    const encodeWav = (samples) => {
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
            // iOS ignores audio.volume, so the master gain is baked into the samples.
            const s = Math.max(-1, Math.min(1, samples[i] * MASTER_GAIN));
            view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        return new Blob([buffer], { type: 'audio/wav' });
    };

    const getNoiseUrl = (type) => {
        if (!noiseUrls[type]) {
            noiseUrls[type] = URL.createObjectURL(encodeWav(renderLoop(type)));
        }
        return noiseUrls[type];
    };

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

    // Must be called synchronously from a user gesture (click) so iOS allows playback.
    const playNoise = () => {
        if (!selectedNoise) return;

        const url = getNoiseUrl(selectedNoise);
        if (audio.src !== url) {
            audio.src = url;
        }

        if ('mediaSession' in navigator && window.MediaMetadata) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: `${capitalize(selectedNoise)} Noise`,
                artist: 'Noise Generator',
                artwork: [
                    { src: 'icons/web-app-manifest-512x512.png', sizes: '512x512', type: 'image/png' }
                ]
            });
        }

        audio.play().then(() => {
            isPlaying = true;
            updateUi();
        }).catch(error => {
            // A newer play() (e.g. quickly switching colors) superseded this one.
            if (error.name === 'AbortError') return;
            console.error('Playback failed:', error);
            isPlaying = false;
            playPauseButton.textContent = 'Play';
            statusText.textContent = 'Could not start audio. Tap Play to try again.';
        });
    };

    const stopNoise = () => {
        audio.pause();
        isPlaying = false;
        updateUi();
    };

    // Keep the UI in sync when playback is paused externally (lock screen controls,
    // headphones unplugged, phone call, etc.).
    audio.addEventListener('pause', () => {
        if (isPlaying && !audio.ended) {
            isPlaying = false;
            updateUi();
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
