document.addEventListener('DOMContentLoaded', () => {
    // Initialize audio context as soon as the DOM is ready
    initializeAudio();

    // Debug info for Safari troubleshooting
    console.log('Browser info:', {
        userAgent: navigator.userAgent,
        audioContext: !!(window.AudioContext || window.webkitAudioContext),
        serviceWorker: !!navigator.serviceWorker
    });

    // Register the service worker for PWA functionality
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./service-worker.js')
            .then(registration => console.log('Service Worker registered with scope:', registration.scope))
            .catch(error => console.error('Service Worker registration failed:', error));
    }

    const noiseButtons = document.querySelectorAll('.noise-btn');
    const playPauseButton = document.getElementById('play-pause-btn');
    const statusText = document.getElementById('status-text');

    let audioContext;
    let noiseNode;
    let gainNode; // Use a single gain node
    let selectedNoise = null;
    let isPlaying = false;
    let userHasInteracted = false; // Track first user interaction for iOS
    const bufferSize = 4096;

    // Web Audio API state variables for different noise colors
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0; // For Pink Noise
    let lastOut = 0; // For Brown Noise
    let lastIn = 0; // For Purple Noise

    // Utility: Detect iOS/Safari
    function isIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    }
   function isSafari() {
        return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    }

    // This function MUST be called from a direct, synchronous user event (e.g., 'click', 'touchend')
    const unlockAudio = () => {
        if (!audioContext) {
            console.log('unlockAudio: AudioContext not ready.');
            return;
        }

        // If context is already running, ensure userHasInteracted is true and return.
        if (audioContext.state === 'running') {
            if (!userHasInteracted) {
                // This can happen if audio started automatically on non-iOS browsers
                // or if a previous unlockAudio call succeeded.
                console.log('unlockAudio: AudioContext is already running.');
                userHasInteracted = true;
            }
            return;
        }

        if (audioContext.state === 'suspended') {
            console.log(`unlockAudio: AudioContext is suspended. Attempting to resume.`);
            audioContext.resume().then(() => {
                console.log('AudioContext resumed successfully from unlockAudio.');
                console.log(`unlockAudio: New AudioContext state: ${audioContext.state}`);
                if (audioContext.state === 'running') {
                    userHasInteracted = true; // Mark that user interaction has successfully started audio.
                }
            }).catch(e => {
                console.error('AudioContext resume failed in unlockAudio:', e);
            });
        } else {
            // Handles 'closed' or any other unexpected states.
            console.log(`unlockAudio: AudioContext in unexpected state: ${audioContext.state}.`);
        }
    };

    const initializeAudio = () => {
        if (audioContext) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) {
                console.error('Web Audio API is not supported in this browser.');
                statusText.textContent = 'Error: Audio not supported.';
                return;
            }
            audioContext = new AudioContext();
            gainNode = audioContext.createGain(); // Create the gain node once
            gainNode.gain.value = 0.5;
            gainNode.connect(audioContext.destination);
            console.log('AudioContext created, state:', audioContext.state);
        } catch (error) {
            console.error('Failed to initialize audio:', error);
            statusText.textContent = 'Error: Could not create audio.';
        }
    };
    
    const createNoiseNode = () => {
        // ScriptProcessorNode is deprecated but necessary for this implementation.
        // For production apps, AudioWorklet is the modern standard.
        const node = audioContext.createScriptProcessor(bufferSize, 1, 1);
        
        node.onaudioprocess = (e) => {
            const output = e.outputBuffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                let noise;
                switch (selectedNoise) {
                    case 'white':
                        noise = Math.random() * 2 - 1;
                        break;
                    case 'pink':
                        const white = Math.random() * 2 - 1;
                        b0 = 0.99886 * b0 + white * 0.0555179;
                        b1 = 0.99332 * b1 + white * 0.0750759;
                        b2 = 0.96900 * b2 + white * 0.1538520;
                        b3 = 0.86650 * b3 + white * 0.3104856;
                        b4 = 0.55000 * b4 + white * 0.5329522;
                        b5 = -0.7616 * b5 - white * 0.0168980;
                        noise = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
                        noise *= 0.11; // Adjust gain
                        b6 = white * 0.115926;
                        break;
                    case 'brown':
                        const brownWhite = Math.random() * 2 - 1;
                        lastOut = (lastOut + (0.02 * brownWhite)) / 1.02;
                        noise = lastOut;
                        noise *= 3.5; // Adjust gain
                        break;
                    case 'purple':
                        const purpleWhite = Math.random() * 2 - 1;
                        noise = purpleWhite - lastIn;
                        lastIn = purpleWhite;
                        noise *= 0.7; // Adjust gain
                        break;
                    default:
                        noise = 0;
                }
                 // Prevent clipping
                output[i] = Math.max(-1, Math.min(1, noise));
            }
        };
        return node;
    };

    const playNoise = () => {
        if (!selectedNoise || !audioContext) {
            console.log('playNoise: Cannot play, no selected noise or AudioContext not ready.');
            return;
        }

        // Play noise only if AudioContext is in a 'running' state.
        // unlockAudio (triggered by user gesture) is responsible for resuming from 'suspended'.
        if (audioContext.state === 'running') {
            actuallyPlayNoise();
        } else if (audioContext.state === 'suspended') {
            console.log('playNoise: AudioContext is suspended. User interaction is required to start audio.');
            // Optionally, provide user feedback that interaction is needed.
            // statusText.textContent = 'Tap or click to enable audio.';
        } else {
            console.error(`playNoise: AudioContext in unexpected state: ${audioContext.state}. Cannot play noise.`);
            statusText.textContent = `Error: Audio context state is ${audioContext.state}.`;
        }
    };

    // Extracted the core logic of playing noise to be called after checks
    const actuallyPlayNoise = () => {
        // Disconnect any existing node
        if (noiseNode) {
            noiseNode.disconnect();
        }

        noiseNode = createNoiseNode();
        noiseNode.connect(gainNode); // Connect to the persistent gain node

        isPlaying = true;
        playPauseButton.textContent = 'Pause';
        statusText.textContent = `Playing ${selectedNoise.charAt(0).toUpperCase() + selectedNoise.slice(1)} Noise`;
        console.log('actuallyPlayNoise: Audio started successfully');
    };


    const stopNoise = () => {
        if (noiseNode) {
            noiseNode.disconnect();
            // We don't destroy the node, just disconnect
        }
        isPlaying = false;
        playPauseButton.textContent = 'Play';
        if (selectedNoise) {
            statusText.textContent = `${selectedNoise.charAt(0).toUpperCase() + selectedNoise.slice(1)} Noise selected`;
        }
    };

    noiseButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            e.preventDefault();
            console.log('[NoiseButton Listener] Click event started for:', button.dataset.noise);

            // Audio is now initialized on DOMContentLoaded
            console.log('[NoiseButton Listener] Calling unlockAudio...');
            unlockAudio(); // Attempt to unlock on every interaction until successful
            console.log('[NoiseButton Listener] unlockAudio call complete. AudioContext state:', audioContext ? audioContext.state : 'N/A');

            // Deactivate other buttons
            console.log('[NoiseButton Listener] Deactivating other buttons...');
            noiseButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            console.log('[NoiseButton Listener] Current button activated.');
            
            const newNoise = button.dataset.noise;
            console.log('[NoiseButton Listener] newNoise:', newNoise);

            if (selectedNoise !== newNoise) {
                console.log(`[NoiseButton Listener] selectedNoise changed from ${selectedNoise} to ${newNoise}`);
                selectedNoise = newNoise;
                // If already playing, switch the noise type immediately
                if (isPlaying) {
                    console.log('[NoiseButton Listener] Noise type changed while playing. Stopping old, starting new.');
                    // Stop current noise, then play new one.
                    // playNoise() will handle the AudioContext state checks.
                    stopNoise(); // Stop first to ensure clean transition
                    playNoise();
                } else {
                    // Update status text if not playing
                    console.log('[NoiseButton Listener] Noise type selected while not playing.');
                    statusText.textContent = `${selectedNoise.charAt(0).toUpperCase() + selectedNoise.slice(1)} Noise selected`;
                }
            } else {
                console.log('[NoiseButton Listener] Same noise type selected:', newNoise);
            }
            
            playPauseButton.disabled = false;
            console.log('[NoiseButton Listener] Play/Pause button ENABLED.');
        });
    });

    playPauseButton.addEventListener('click', (e) => {
        e.preventDefault();
        if (!selectedNoise) return;

        // Audio is now initialized on DOMContentLoaded
        unlockAudio(); // Attempt to unlock on every interaction until successful

        if (isPlaying) {
            stopNoise();
        } else {
            playNoise();
        }
    });
});
